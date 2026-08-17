//! Sidecar side of the MCP bridge: the client that hands data-path calls to a
//! running desktop app instead of opening pools of its own.
//!
//! See [`crate::bridge`] for the rationale. This half's job is narrow but has
//! one rule that has to be exactly right — the fallback rule in
//! [`BridgeClient::call`].

use crate::bridge::protocol::{BridgeRequest, BridgeResponse, Hello, HelloAck, PROTOCOL_VERSION};
use crate::bridge::read_discovery;
use serde_json::Value;
use std::io;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

/// How long to wait for the app to answer one call.
///
/// Generous, because the app is running a real query on our behalf and a slow
/// database is not a broken bridge. The MCP client has its own, shorter, notion
/// of patience anyway; this only bounds the case where the app process is wedged
/// rather than busy.
const CALL_TIMEOUT: Duration = Duration::from_secs(300);

/// How long to wait for the initial connect + handshake. Short: the app is on
/// loopback, and this runs on the sidecar's *first* tool call, where a stall
/// would look like a hung MCP server.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// What went wrong with a bridged call. The distinction drives the fallback.
#[derive(Debug)]
pub enum BridgeError {
    /// The app could not be reached, or the connection broke. **Only ever
    /// returned before the request was written** — see [`BridgeClient::call`].
    Unreachable(String),
    /// The app answered, and the answer was an error. This is the database's
    /// or the policy's verdict and must be reported as-is.
    Remote(String),
}

/// A live connection to the desktop app.
///
/// The stream is behind a `Mutex` rather than being cloned per call: the
/// protocol is strictly one request, one response, in order, on one connection.
/// Two concurrent calls would interleave their lines and each would read the
/// other's answer. MCP dispatches tools serially so contention is nil, but the
/// lock is what makes that a guarantee rather than an assumption.
pub struct BridgeClient {
    stream: Mutex<Connection>,
    /// Connections this client is allowed to reach, re-sent on reconnect.
    allowed: Vec<String>,
}

struct Connection {
    reader: tokio::io::Lines<BufReader<OwnedReadHalf>>,
    writer: OwnedWriteHalf,
}

impl BridgeClient {
    /// Try to attach to a running desktop app.
    ///
    /// `None` — never an error — when there is no app to attach to: no
    /// discovery file, a stale one pointing at a dead port, a version mismatch,
    /// or a rejected token. Every one of those is a normal reason to fall back
    /// to local pools, and none of them should fail a tool call or print
    /// anything alarming.
    pub async fn connect(allowed: Vec<String>) -> Option<Self> {
        let discovery = read_discovery()?;
        let connection = timeout(
            CONNECT_TIMEOUT,
            Self::handshake(&discovery.token, discovery.port, &allowed),
        )
        .await
        .ok()?
        .ok()?;
        Some(Self {
            stream: Mutex::new(connection),
            allowed,
        })
    }

    async fn handshake(token: &str, port: u16, allowed: &[String]) -> io::Result<Connection> {
        let stream = TcpStream::connect(("127.0.0.1", port)).await?;
        // Interactive request/response on loopback: Nagle would add latency to
        // every call for no batching benefit.
        stream.set_nodelay(true)?;
        let (read_half, mut writer) = stream.into_split();
        let mut reader = BufReader::new(read_half).lines();

        write_line(
            &mut writer,
            &Hello {
                protocol_version: PROTOCOL_VERSION,
                token: token.to_string(),
                allowed: allowed.to_vec(),
            },
        )
        .await?;

        let line = reader
            .next_line()
            .await?
            .ok_or_else(|| io::Error::other("app closed the connection during handshake"))?;
        let ack: HelloAck = serde_json::from_str(&line).map_err(io::Error::other)?;
        if let Some(error) = ack.error {
            return Err(io::Error::other(error));
        }
        Ok(Connection { reader, writer })
    }

    /// Send one request and await its reply.
    ///
    /// # The fallback rule
    ///
    /// `Unreachable` is returned **only** when the request never left this
    /// process — i.e. the write itself failed, or a reconnect could not be
    /// established. Once bytes are on the wire, a broken connection comes back
    /// as `Remote`, not `Unreachable`.
    ///
    /// That asymmetry is deliberate and is the whole reason [`BridgeError`]
    /// has two variants. The caller's fallback for `Unreachable` is "run it
    /// against a local pool instead" — which is correct for a request that was
    /// never sent, and a data-corruption bug for one that was: if the app
    /// applied an `INSERT` and then died before replying, retrying locally
    /// writes the row twice. When we cannot tell whether a mutating call
    /// landed, the only safe answer is to report the failure.
    pub async fn call(&self, request: &BridgeRequest) -> Result<Value, BridgeError> {
        let mut guard = self.stream.lock().await;

        let payload = serde_json::to_vec(request)
            .map_err(|e| BridgeError::Unreachable(format!("could not encode request: {e}")))?;

        // One reconnect attempt, but only for a request we have not sent yet:
        // an MCP client keeps a sidecar alive for days, across app restarts, so
        // the *first* call after the app came back would otherwise always fail.
        //
        // Why retrying is safe even for a write: the framing is
        // newline-delimited, and the newline is a *separate* write from the
        // payload. A failure therefore always leaves an incomplete line on the
        // wire, which the app can never parse into a request — so a failed send
        // provably did not execute, and re-sending cannot double-apply. If the
        // framing ever stops being newline-delimited, this reasoning goes with
        // it.
        if let Err(e) = write_payload(&mut guard.writer, &payload).await {
            let unsent = |e: std::io::Error| {
                BridgeError::Unreachable(format!(
                    "{e} (request not sent{})",
                    if request.is_mutating() {
                        "; the incomplete frame cannot have been executed"
                    } else {
                        ""
                    }
                ))
            };
            match self.reconnect().await {
                Some(fresh) => {
                    *guard = fresh;
                    if let Err(e) = write_payload(&mut guard.writer, &payload).await {
                        return Err(unsent(e));
                    }
                }
                None => return Err(unsent(e)),
            }
        }

        // From here on the request is in flight. Every failure is `Remote`.
        let line = match timeout(CALL_TIMEOUT, guard.reader.next_line()).await {
            Err(_) => {
                return Err(BridgeError::Remote(
                    "the HuginnDB app did not answer in time".into(),
                ))
            }
            Ok(Err(e)) => return Err(BridgeError::Remote(e.to_string())),
            Ok(Ok(None)) => {
                return Err(BridgeError::Remote(
                    "the HuginnDB app closed the connection before answering".into(),
                ))
            }
            Ok(Ok(Some(line))) => line,
        };

        let response: BridgeResponse = serde_json::from_str(&line)
            .map_err(|e| BridgeError::Remote(format!("malformed reply: {e}")))?;
        match (response.ok, response.err) {
            (Some(wrapper), _) => Ok(wrapper.value),
            (None, Some(err)) => Err(BridgeError::Remote(err)),
            (None, None) => Err(BridgeError::Remote("empty reply".into())),
        }
    }

    /// Re-read the discovery file and dial again — the app may have restarted
    /// on a different port with a different token since we attached.
    async fn reconnect(&self) -> Option<Connection> {
        let discovery = read_discovery()?;
        timeout(
            CONNECT_TIMEOUT,
            Self::handshake(&discovery.token, discovery.port, &self.allowed),
        )
        .await
        .ok()?
        .ok()
    }
}

async fn write_line<T: serde::Serialize>(writer: &mut OwnedWriteHalf, value: &T) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(io::Error::other)?;
    write_payload(writer, &payload).await
}

async fn write_payload(writer: &mut OwnedWriteHalf, payload: &[u8]) -> io::Result<()> {
    writer.write_all(payload).await?;
    writer.write_all(b"\n").await?;
    // Explicit flush: `OwnedWriteHalf` is unbuffered today, but a caller
    // blocking on a reply that is sitting in a buffer is a deadlock that costs
    // nothing to rule out.
    writer.flush().await
}

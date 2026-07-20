# Conector MCP de HuginnDB

> Nota: este archivo es la traducción al español de `MCP.md`. Si ves algo
> desactualizado respecto al original en inglés, ese es el que manda.

`huginndb-mcp` es un servidor headless de [Model Context Protocol](https://modelcontextprotocol.io)
que expone las bases de datos que HuginnDB ya conoce — los perfiles de
`profiles.json`, con las contraseñas leídas del llavero del sistema — a un
cliente MCP como Claude Code, Claude Desktop, Cursor, Antigravity o Codex. El
asistente puede entonces inspeccionar el estado *real* de tus bases de datos
(esquema, filas de ejemplo, recuentos de filas, versión del servidor,
privilegios) en lugar de adivinar.

Al ser un servidor MCP estándar sobre stdio sin código específico por
cliente, **cualquier** cliente MCP compatible con la especificación puede
usarlo — las secciones de abajo cubren los que tienen particularidades de
configuración que merece la pena documentar; cualquier otro que hable MCP (el
agente integrado de un editor, un harness a medida, …) funciona igual en
cuanto le indiques la ruta al binario.

Es un proceso **separado**. No comparte las conexiones abiertas de la app de
escritorio en ejecución; abre sus propios *pools* de forma perezosa, bajo
demanda, y solo para las conexiones que expongas explícitamente. Cada conexión
expuesta tiene un **nivel de escritura** — `read-only` (por defecto), `data` o
`full` — configurado por conexión en **Ajustes → MCP**; las lecturas siempre
funcionan, y las escrituras solo se ejecutan si el nivel de esa conexión lo
permite. Ver [Seguridad](#seguridad).

Consulta [`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md) para el
razonamiento de diseño (en inglés).

## Obtener el binario

**Instalaciones empaquetadas (el caso normal):** `huginndb-mcp` se distribuye
como *sidecar* de Tauri, instalado justo al lado del ejecutable principal —
nada que compilar. Abre **Ajustes → MCP** en la app: muestra la ruta
resuelta, te deja elegir qué conexiones guardadas exponer, y genera
configuración lista para pegar en Claude Code / Claude Desktop / otros
clientes. El resto de este documento es la referencia de lo que ofrece ese
panel, más los clientes para los que no genera una plantilla (Codex).

**Compilar desde el código fuente (solo desarrollo):** el conector vive en su
propio crate del workspace (`src-tauri/mcp-server/`), fuera del `Cargo.toml`
de la app de escritorio para que un `pnpm tauri:build` normal nunca lo
compile ni lo empaquete por su cuenta (ver el gotcha del `[[bin]]` múltiple
de tauri-bundler en `CLAUDE.md` para el porqué; el workflow de release lo
prepara aparte como sidecar). Compílalo explícitamente:

```bash
cd src-tauri
cargo build --release -p huginndb-mcp
# binario en: src-tauri/target/release/huginndb-mcp[.exe]
```

## Configurar un cliente

Cada cliente apunta a la **ruta absoluta** del conector — consíguela en
Ajustes → MCP en una instalación empaquetada, o mira [Obtener el
binario](#obtener-el-binario) para una compilación desde fuente (en Windows,
`…\target\release\huginndb-mcp.exe`).

Donde una plantilla diga `<profile-id>`, usa el `id` UUID estable de la
conexión que quieras exponer. Búscalo en la app de escritorio, o léelo de
`profiles.json` en el directorio de configuración de tu plataforma
(`%APPDATA%\HuginnDB` en Windows, `~/.config/HuginnDB` en Linux,
`~/Library/Application Support/HuginnDB` en macOS) — es el campo `id`, no el
`name` visible. Expón varias a la vez con una lista separada por comas
(`--connections id1,id2`).

### Claude Code (CLI)

```bash
claude mcp add huginndb -s user -- /ruta/absoluta/a/huginndb-mcp --connections <profile-id>
```

- El `--` separa el comando+args del servidor de los flags propios de
  `claude`.
- `-s user` lo deja disponible en todos los proyectos; usa `-s local` (el
  valor por defecto) solo para el repo actual.
- Compruébalo con `/mcp` dentro de una sesión, y luego prueba *"con huginndb,
  lista las tablas de `<nombre>` y muéstrame 5 filas de la primera"*.

Configuración equivalente escrita a mano (`~/.claude.json`, o un `.mcp.json`
de proyecto):

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/ruta/absoluta/a/huginndb-mcp",
      "args": ["--connections", "<profile-id>"]
    }
  }
}
```

### Claude Desktop

Ajustes → Developer → **Edit Config** abre `claude_desktop_config.json`
(`%APPDATA%\Claude\` en Windows, `~/Library/Application Support/Claude/` en
macOS). Añade el servidor y **reinicia la app**:

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "C:\\ruta\\a\\huginndb-mcp.exe",
      "args": ["--connections", "<profile-id>"]
    }
  }
}
```

En Windows, duplica las barras invertidas en la ruta JSON (`\\`).

### Cursor

Cursor lee los servidores MCP de un `mcp.json` con la misma forma
`mcpServers` que Claude Desktop — bien `.cursor/mcp.json` en la raíz de un
proyecto (limitado a ese proyecto) o `~/.cursor/mcp.json` (global, todos los
proyectos):

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/ruta/absoluta/a/huginndb-mcp",
      "args": ["--connections", "<profile-id>"]
    }
  }
}
```

También puedes añadirlo desde la UI de Ajustes → MCP de Cursor ("Add new
global MCP server") si prefieres no editar el archivo a mano. De cualquier
forma, el snippet JSON que genera Ajustes → MCP en la app se pega tal cual.

### Antigravity (Google)

Antigravity — el IDE agéntico de Google potenciado por Gemini — usa la misma
forma `mcpServers`/`command`/`args`. En vez de buscar el archivo de
configuración (su ubicación ha cambiado entre versiones de Antigravity),
añade el servidor desde la UI: **panel del Agente → menú "…" → MCP Servers →
Manage MCP Servers → View raw config**, y pega:

```json
{
  "mcpServers": {
    "huginndb": {
      "command": "/ruta/absoluta/a/huginndb-mcp",
      "args": ["--connections", "<profile-id>"]
    }
  }
}
```

Guarda y pulsa refrescar en la lista de Installed MCP Servers. (La única
diferencia real de Antigravity frente a Cursor/Claude Desktop está en los
servidores remotos por HTTP, que usan `serverUrl` en vez de
`command`/`args` — no aplica aquí, ya que `huginndb-mcp` es un proceso local
sobre stdio.)

### Codex CLI

Codex lee los servidores MCP de `~/.codex/config.toml` (TOML, no el JSON de
Claude). Añade una tabla `[mcp_servers.<nombre>]`:

```toml
[mcp_servers.huginndb]
command = "C:\\ruta\\a\\huginndb-mcp.exe"
args = ["--connections", "<profile-id>"]
# opcional: startup_timeout_sec = 20
```

O añádelo desde la CLI (los servidores stdio toman un comando separado por
`--`):

```bash
codex mcp add huginndb -- /ruta/absoluta/a/huginndb-mcp --connections <profile-id>
```

Las herramientas aparecen entonces bajo el servidor `huginndb` dentro de
Codex.

## Flags de línea de comandos

| Flag | Por defecto | Significado |
| --- | --- | --- |
| `--connections <a,b,c>` | *(ninguna)* | IDs de perfil a los que el servidor puede acceder. **Opt-in**: sin ninguno configurado, no se expone nada. |
| `--max-rows <n>` | `1000` | Límite superior de filas devueltas por una llamada a `run_query` / `browse_table`, para que una llamada no vuelque una tabla entera en el contexto del modelo. |
| `--read-only[=true\|false]` | `false` | Kill-switch global: fuerza **todas** las conexiones a solo lectura sin importar su nivel de escritura guardado. Una forma rápida de exponer el conector en modo garantizado-seguro sin tocar ningún perfil. |
| `--allow-writes` | — | **Obsoleto e ignorado.** Las escrituras ahora se gobiernan por conexión mediante el nivel de escritura configurado en Ajustes → MCP (ver [Seguridad](#seguridad)); este flag ya no concede nada y solo imprime un aviso de obsolescencia. |

Los flags aceptan tanto `--flag valor` como `--flag=valor`.

## Herramientas

| Herramienta | Qué hace |
| --- | --- |
| `list_connections` | Qué bases de datos puede alcanzar este servidor. |
| `list_databases` | Bases de datos / esquemas / catálogos de una conexión. |
| `list_tables` | Tablas y vistas, con recuentos de filas y tamaños aproximados. |
| `describe_table` | Estructura completa: columnas, tipos, nulabilidad, PK, FKs, índices. |
| `list_indexes` | Índices de una tabla y las columnas que cubre cada uno. |
| `run_query` | Ejecuta una única sentencia (SQL para Postgres/MySQL/SQLite, estilo mongosh para MongoDB). Las lecturas siempre funcionan; las escrituras requieren que el nivel de la conexión lo permita (`data` para DML, `full` para DDL). |
| `browse_table` | Navega una página de filas sin escribir SQL. |
| `server_version` | El motor y la versión conectados. |
| `list_users` / `list_privileges` | Usuarios/roles del servidor y sus permisos. |
| `insert_row` *(escritura)* | Inserta una fila (valores como texto; valores por defecto de la BD para columnas omitidas). Requiere `data` o `full`. |
| `update_cell` *(escritura)* | Actualiza una columna de la única fila identificada por su clave primaria completa. Requiere `data` o `full`. |
| `delete_rows` *(escritura)* | Borra una o más filas, cada una identificada por su clave primaria completa. Requiere `data` o `full`. |

`list_connections` informa del nivel de escritura efectivo de cada conexión,
para que el asistente sepa de antemano qué puede hacer.

## MongoDB: apuntar a una base de datos en una conexión multi-base

Una conexión de MongoDB sin base de datos por defecto (`list_connections`
devuelve `database: ""` — la URI no tiene `/nombrebd`) no puede ejecutar
ninguna herramienta a nivel de tabla hasta que sepa qué base de datos usar,
ya que no hay nada equivalente a un catálogo SQL al que recurrir. Pasa el
nombre de la base de datos mediante:

- `schema` en `list_tables`, `describe_table`, `list_indexes` y
  `browse_table`.
- `database` en `run_query` (su `sql` a secas no tiene campo para esto).

El servidor lo resuelve igual que el explorador de esquema de la app de
escritorio cuando expandes una base de datos — reutilizando el mismo cliente
de MongoDB y re-etiquetándolo, sin nueva conexión ni reautenticación — y lo
cachea, así que llamadas repetidas para la misma base de datos en la misma
conexión son baratas. Una conexión de una sola base de datos (con
`/nombrebd` ya en su URI) ignora esto — solo hace falta cuando
`list_connections` muestra un `database` vacío.

## Seguridad

- **Escrituras controladas por conexión.** Cada conexión expuesta tiene un
  nivel de escritura, configurado en **Ajustes → MCP** y guardado en
  `profiles.json`:
  - **`read-only`** (por defecto) — solo lecturas. `run_query` acepta
    `SELECT` / `WITH` / `SHOW` / `EXPLAIN` / `PRAGMA` (SQL) o
    `find`/`aggregate`/`countDocuments`/`distinct` (MongoDB), clasificado con
    el mismo clasificador de operaciones que usa el editor de consultas de
    escritorio — no una simple coincidencia de palabras clave SQL, así que las
    lecturas de mongosh no se confunden con escrituras. Toda herramienta de
    escritura se rechaza.
  - **`data`** — añade DML a nivel de fila: `INSERT`/`UPDATE`/`DELETE` vía
    `run_query`, más las herramientas `insert_row` / `update_cell` /
    `delete_rows`. Sin cambios de esquema.
  - **`full`** — añade DDL (`CREATE`/`DROP`/`ALTER`/`TRUNCATE`/…) vía
    `run_query`.

  El nivel se relee de disco en **cada intento de escritura**, así que
  cambiarlo en la app surte efecto sin reiniciar el cliente de IA.
- **La aprobación la da el cliente.** El conector es un proceso headless que
  lanza tu cliente MCP; no puede mostrar un prompt. La aprobación por acción
  («¿permitir esta herramienta?») la pide el cliente (Claude Code / Desktop /
  Cursor la piden). El papel del conector es la *política* (qué se permite) y
  la *auditoría*.
- **Log de auditoría.** Cada escritura (éxito o fallo) añade una línea a
  `mcp-audit.log`, en el mismo directorio de configuración que `profiles.json`.
  Las lecturas no se registran, así que el fichero es un registro limpio de las
  operaciones que cambian estado.
- **Guarda anti-tabla-entera.** Un `UPDATE`/`DELETE` sin `WHERE` en `run_query`
  se rechaza de plano, en cualquier nivel — añade un predicado explícito
  (`WHERE 1=1` si de verdad quieres todas las filas).
- **Kill-switch global.** `--read-only` fuerza todas las conexiones a solo
  lectura sin importar su nivel guardado.
- **Exposición opt-in.** Solo los IDs de perfil que pases a `--connections`
  son alcanzables; cualquier otra llamada a una conexión no nombrada se
  rechaza.
- **Sin texto plano nuevo.** Las contraseñas se leen del llavero del sistema
  en el momento de conectar, igual que la app de escritorio. El conector
  nunca las registra ni las persiste (el log de auditoría registra sentencias
  y recuentos de filas, nunca credenciales).
- **Límite de filas.** `--max-rows` acota cada conjunto de resultados.

## Drivers soportados

PostgreSQL, MySQL, SQLite y MongoDB — los mismos drivers que la app de
escritorio, mediante el mismo código de backend.

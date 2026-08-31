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

Es un proceso **separado**. Por defecto abre sus propios *pools* de forma
perezosa, bajo demanda, y solo para las conexiones que expongas explícitamente:
no comparte los de la app de escritorio en ejecución. *Puede* compartirlos si
activas **Ajustes → Conexiones → Compartir pools con el conector MCP**, lo que
da a toda la máquina un único presupuesto de conexiones por servidor; ver
[Compartir los pools de la app](#compartir-los-pools-de-la-app). Cada conexión
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

## Huella de conexiones

El conector es un proceso **separado** de la app de escritorio de HuginnDB, con
sus propios pools de conexiones. No comparte los de la app. Eso tiene una
consecuencia que conviene conocer antes de apuntarlo a una base de datos que
también usa otra gente:

- Cada cliente MCP que tenga `huginndb-mcp` configurado lanza **su propia
  copia**. Claude Code y Claude Desktop configurados contra el mismo perfil son
  dos procesos, cada uno con su pool.
- Esos pools se suman a los de la app de escritorio, a los del origen de datos de
  tu IDE y a los de cualquier backend que apunte al mismo servidor. Todos cuentan
  contra el mismo `max_connections` del servidor.

Dos valores por defecto lo mantienen acotado:

- **`--max-connections` vale `2`** por conexión expuesta, en lugar del `5` de la
  app de escritorio. MCP es petición/respuesta sobre stdio y las herramientas se
  despachan de una en una, así que un pool mayor no compra nada aquí. Es además
  un presupuesto *por servidor* dentro de este proceso: dos conexiones expuestas
  que apunten al mismo host lo comparten en lugar de tener una cada una.
- **Los pools inactivos se cierran a los 5 minutos** sin llamadas. El conector es
  de vida larga pero su trabajo va a ráfagas; un pool abierto para una pregunta no
  se mantiene el resto de la semana. Se reabre de forma transparente en la
  siguiente llamada.

### Compartir los pools de la app

Si la app de escritorio está en ejecución, puede atender las consultas del
conector con *sus propios* pools — activa **Ajustes → Conexiones → Compartir
pools con el conector MCP**. Entonces:

- Toda la máquina tiene un único presupuesto por servidor. La app es dueña de
  todas las conexiones; el conector (y cualquier otro conector, uno por cliente
  MCP) no abre ninguna.
- La actividad del conector aparece en la **Consola** de la app en directo — cada
  exploración, consulta y escritura, en el momento — en lugar de solo en
  `mcp-audit.log` a posteriori. Las escrituras se siguen auditando en ese fichero
  igualmente.
- El nivel de escritura lo vuelve a comprobar la app, de forma independiente a la
  comprobación del propio conector.

Está **desactivado por defecto**, porque abre un listener (solo loopback y
protegido por token) que da frente a todas las bases de datos que tengas
guardadas. Cuando la app no está en ejecución —o el ajuste está apagado— el
conector abre sus propios pools exactamente como se describe arriba, y lo indica
por stderr si pierde la app a mitad de sesión.

Si un servidor sigue justo, fija un techo por conexión en HuginnDB (Ajustes →
Conexiones, o el campo **Máximo de conexiones** de la propia conexión). Se guarda
en `profiles.json`, que este conector lee, así que se aplica al sidecar sin
configuración adicional. Ajustes → Conexiones muestra además cuántos pools
mantiene la app de escritorio ahora mismo, y permite liberar los de cada base de
datos a demanda.

## Herramientas

| Herramienta | Qué hace |
| --- | --- |
| `list_connections` | Qué bases de datos puede alcanzar este servidor. |
| `list_databases` | Bases de datos / esquemas / catálogos de una conexión. |
| `list_tables` | Tablas y vistas, con recuentos de filas y tamaños aproximados. |
| `describe_table` | Estructura completa: columnas, tipos, nulabilidad, PK, FKs, índices. Funciona también sobre una vista, y añade un objeto `view` con su definición cuando la relación lo es — `query` (el cuerpo del SELECT) en SQL, `viewOn` + `pipeline` en MongoDB. |
| `list_indexes` | Índices de una tabla y las columnas que cubre cada uno. En MongoDB cada entrada lleva además un objeto `mongo` con la definición completa — dirección y tipo de cada clave, `sparse`, TTL, filtro parcial, colación, pesos, tamaño y uso. Léelo antes de recrear un índice: la lista de columnas por sí sola no distingue `{createdAt: -1}` de `{createdAt: 1}`. |
| `run_query` | Ejecuta una única sentencia (SQL para Postgres/MySQL/SQLite/SQL Server, estilo mongosh para MongoDB). Las lecturas siempre funcionan; las escrituras requieren que el nivel de la conexión lo permita (`data` para DML, `full` para DDL). |
| `browse_table` | Navega una página de filas sin escribir SQL. |
| `server_version` | El motor y la versión conectados. |
| `list_users` / `list_privileges` | Usuarios/roles del servidor y sus permisos. |
| `pulse_health` | Constantes vitales en vivo — consultas/s, presión de conexiones, tasa de aciertos de caché — normalizadas a un único catálogo de métricas sea cual sea el motor. Solo MySQL y MongoDB. |
| `pulse_metrics` | Histórico guardado de una métrica, leído del muestreador en disco de Pulse, de más antiguo a más reciente. Vacío salvo que la conexión tenga el muestreador de histórico de Pulse activado en Ajustes. |
| `pulse_top_queries` | Sentencias en las que el servidor ha invertido más tiempo, cada una con un `sample` ejecutable cuando hay uno disponible. |
| `pulse_explain` | El plan que usaría el servidor para una sentencia — típicamente el propio `sample` de una fila de `pulse_top_queries` — sin llegar a ejecutarla. Rechaza cualquier cosa que no sea de solo lectura, una única sentencia, y que no sea ella misma `EXPLAIN`/`ANALYZE`. |
| `pulse_storage` | Las relaciones más grandes de la conexión, de mayor a menor, desglosadas en datos / índices / espacio libre. |
| `pulse_sessions` | Cada sesión u operación abierta ahora mismo en el servidor, con una cadena de bloqueo a mejor esfuerzo en MySQL. |
| `pulse_index_usage` | Uso de índices en las relaciones más grandes, de menos a más leído — la forma más rápida de detectar un índice que nadie lee. |
| `insert_row` *(escritura)* | Inserta una fila (valores como texto; valores por defecto de la BD para columnas omitidas). Requiere `data` o `full`. |
| `update_cell` *(escritura)* | Actualiza una columna de la única fila identificada por su clave primaria completa. Requiere `data` o `full`. |
| `delete_rows` *(escritura)* | Borra una o más filas, cada una identificada por su clave primaria completa. Requiere `data` o `full`. |
| `save_view` *(escritura)* | Crea una vista, redefine una existente o la renombra. Pasa solo `name` y `query` — la herramienta lee la definición actual para decidir cuál de las tres es. Con `preview: true` devuelve las sentencias sin ejecutarlas, y eso es una lectura. Requiere `full`. |
| `drop_view` *(escritura)* | Elimina una vista. Rechaza cualquier cosa que no lo sea. Requiere `full`. |
| `create_index` *(escritura)* | **Solo MongoDB.** Crea un índice. `keys` es texto fuente (`{createdAt: -1}`, `{location: "2dsphere"}`), más las opciones habituales — unique, sparse, hidden, TTL, filtro parcial, colación, pesos de texto y una vía de escape `extraOptions`. Requiere `full`. |
| `drop_index` *(escritura)* | **Solo MongoDB.** Elimina un índice por nombre. `_id_` se rechaza. Requiere `full`. |

`list_connections` informa del nivel de escritura efectivo de cada conexión,
para que el asistente sepa de antemano qué puede hacer.

### Índices: por qué las dos herramientas de escritura son solo de MongoDB

En los drivers SQL un índice se crea con `CREATE INDEX`, que `run_query` alcanza
en `full` y que es estrictamente más expresivo que cualquier forma portable —
`USING gin`, `INCLUDE`, un predicado parcial, un índice sobre expresión. Una
herramienta tendría que aplanar todo eso en un conjunto fijo de campos, y el
vocabulario de índices del lado SQL de HuginnDB es deliberadamente estrecho
(nombre, columnas, unique) porque existe para que el editor de estructura lo
*diffee*, no para describir cualquier índice que un servidor sepa construir.
Exponerlo como herramienta sería un retroceso.

MongoDB es el caso opuesto: hasta 1.19.0 la gramática mongosh no tenía
`createIndex` en absoluto, así que la operación no era alcanzable *por ninguna
vía*. Ahora existen las dos — las dos herramientas y
`db.coll.createIndex(...)` por `run_query` — y comparten una sola
implementación.

No hay herramienta para «editar» un índice porque MongoDB no puede alterarlo en
sitio: reemplazarlo es `drop_index` y luego `create_index`, y dejarlo en dos
llamadas mantiene visible para quien llama la ventana en la que el índice no
existe. Ocultar un índice (`collMod`) se alcanza por `run_query` como
`db.coll.hideIndex("nombre")` — la forma reversible de ensayar un borrado.

### Pulse: cómo `pulse_metrics` llega al histórico del muestreador

`pulse_metrics` lee `pulse.db` — el fichero SQLite en el que el propio
muestreador en segundo plano de HuginnDB escribe una lectura cada 60 segundos
por cada conexión con el muestreador de histórico de Pulse activado
(Ajustes → Pulse). Llegar hasta él no necesita ningún tratamiento especial
para ninguna de las dos formas en que corre este conector:

- **Con el puente de la app de escritorio activo**, esta herramienta (como
  cualquier otra) la sirve la app, así que lee directamente el propio
  manejador de `pulse.db` de la app.
- **En modo sidecar independiente**, el conector abre el *mismo* fichero en
  la misma ruta — `pulse.db` vive junto a `profiles.json` en el directorio de
  configuración de la plataforma, resuelto de forma idéntica por los dos
  procesos — y solo llega a ejecutar un `SELECT` contra él. Nunca ejecuta el
  muestreador él mismo (ese bucle solo arranca dentro de la secuencia de
  lanzamiento de la propia app de escritorio), así que no hay ninguna vía de
  escritura que proteger; el modo de journal WAL de este fichero, que usa
  siempre, ya permite cualquier número de lectores concurrentes junto al
  único escritor de la app.

En cualquiera de los dos casos, una respuesta vacía significa que el
muestreador de Pulse nunca se ha ejecutado para esa conexión — actívalo en
Ajustes, espera una lectura o dos, y pregunta de nuevo.

## MongoDB: apuntar a una base de datos en una conexión multi-base

Una conexión de MongoDB sin base de datos por defecto (`list_connections`
devuelve `database: ""` — la URI no tiene `/nombrebd`) no puede ejecutar
ninguna herramienta a nivel de tabla hasta que sepa qué base de datos usar,
ya que no hay nada equivalente a un catálogo SQL al que recurrir. Pasa el
nombre de la base de datos mediante:

- `schema` en `list_tables`, `describe_table`, `list_indexes`,
  `browse_table`, `save_view` y `drop_view`.
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
    `run_query`, más las herramientas `save_view` / `drop_view` /
    `create_index` / `drop_index`. En MongoDB este es también el nivel de
    `createIndex`/`dropIndex`/`hideIndex`, `drop()` y `renameCollection` vía
    `run_query`.

  Un índice y un *namespace* también son esquema, por la misma razón y con la
  misma consecuencia: `create_index` y `drop_index` viven en `full`, igual que
  cualquier sentencia de MongoDB que toque un índice o la existencia de una
  colección.

  Una vista es esquema, y eso deja su gestión en `full` y no en `data`. Suena
  raro por un segundo — eliminar una *vista* pide `full` mientras que borrar
  *filas* solo pide `data` — y es la misma asimetría que ya existe entre
  `DROP TABLE` y `DELETE FROM`. Es además la única respuesta coherente: el
  `CREATE OR REPLACE VIEW` que podrías escribir a mano por `run_query` está
  clasificado como DDL, así que una conexión en `data` lo tiene rechazado, y
  una herramienta que permitiera el mismo cambio devolvería justo lo que el
  nivel acaba de negar. El `preview: true` de `save_view` es una excepción de
  verdad, no un agujero: construye las sentencias y no ejecuta nada, así que
  está clasificado como lectura y funciona en cualquier nivel.

  El nivel se relee de disco en **cada intento de escritura**, así que
  cambiarlo en la app surte efecto sin reiniciar el cliente de IA.
- **La aprobación la da el cliente.** El conector es un proceso headless que
  lanza tu cliente MCP; no puede mostrar un prompt. La aprobación por acción
  («¿permitir esta herramienta?») la pide el cliente (Claude Code / Desktop /
  Cursor la piden). El papel del conector es la *política* (qué se permite) y
  la *auditoría*. Son dos puertas independientes, y un nivel `full` es un
  *techo*, no una instrucción para el cliente — ver [Cuando el bloqueo viene
  del cliente, no del
  conector](#cuando-el-bloqueo-viene-del-cliente-no-del-conector).
- **Log de auditoría.** Cada escritura (éxito o fallo) añade una línea a
  `mcp-audit.log`, en el mismo directorio de configuración que `profiles.json`.
  Las lecturas no se registran, así que el fichero es un registro limpio de las
  operaciones que cambian estado.
- **Guarda anti-relación-entera.** Un `UPDATE`/`DELETE` sin `WHERE` en
  `run_query` se rechaza de plano, en cualquier nivel — añade un predicado
  explícito (`WHERE 1=1` si de verdad quieres todas las filas). MongoDB entra
  en la misma guarda: `updateMany({})` y `deleteMany({})` se rechazan, y la
  forma de decir que lo quieres es un predicado trivialmente cierto, p. ej.
  `deleteMany({_id: {$exists: true}})`. `drop()` queda fuera: su alcance no es
  ambiguo y ya está detrás de `full`, exactamente como `DROP TABLE`.
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

### Cuando el bloqueo viene del cliente, no del conector

Una escritura la puede rechazar *cualquiera* de las dos puertas, y cada una
responde a un dueño distinto. El síntoma que despista: una conexión en `full`
en Ajustes → MCP y el asistente diciendo aun así que no puede ejecutar un
`CREATE`/`ALTER`/`DROP`.

Distinguirlas lleva un segundo:

| | Rechazo del conector | Bloqueo del cliente |
| --- | --- | --- |
| Qué ves | Un *resultado* de la herramienta nombrando el nivel: *«connection … has MCP write policy "read-only", which does not permit this operation (needs at least "full")»* | La denegación del propio cliente. En el modo auto de Claude Code el motivo suele ser el texto fijo `Blocked by classifier` |
| `mcp-audit.log` | Se añadió una línea (los rechazos también se registran) | **Nada** — la llamada nunca llegó al conector |
| Quién lo cambia | Tú, en HuginnDB → Ajustes → MCP | Quien ejecuta el cliente de IA, en *su* configuración |

En concreto con Claude Code: en [modo auto](https://code.claude.com/docs/en/permission-modes#eliminate-prompts-with-auto-mode)
un segundo modelo — el clasificador — revisa cada acción en lugar de
preguntarle al usuario, y las llamadas a herramientas MCP pasan por ahí. Su
lista de bloqueos por defecto incluye *«production deploys and migrations»* y
*«modifying shared infrastructure»*, y hasta que nombres objetivos concretos
trata cualquier host o namespace cuyo nombre lleve `prod` como objetivo remoto
sensible. Un DDL contra un servidor de base de datos real encaja justo ahí,
diga lo que diga la política de HuginnDB — y el clasificador no tiene forma de
saber que el servidor es una instancia de pruebas desechable si nadie se lo
dice.

Los arreglos viven todos en el lado del cliente, y todos son decisión de la
persona que lo ejecuta — el conector no puede ni debe intentar influir en ellos:

- **Puntual:** abrir `/permissions` → **Recently denied** y pulsar `r` sobre la
  entrada para reintentarla con aprobación manual.
- **Ser específico en la petición.** La intención explícita del usuario levanta
  los bloqueos blandos del clasificador; una genérica no. *«ordena el esquema»*
  no autoriza un DDL, *«ejecuta este `ALTER TABLE` en la base `sandbox`»* sí.
- **Pre-aprobar la herramienta** con una [regla
  allow](https://code.claude.com/docs/en/permissions#permission-rule-syntax) en
  `~/.claude/settings.json`, que se resuelve *antes* de que corra el
  clasificador. El segmento del servidor tiene que ser literal — un glob sin
  anclar se ignora:

  ```json
  {
    "permissions": {
      "allow": ["mcp__huginndb__run_query"]
    }
  }
  ```

- **Dar contexto al clasificador** sobre la base de datos con entradas
  [`autoMode`](https://code.claude.com/docs/en/auto-mode-config) (solo en
  settings de usuario o gestionados — el clasificador ignora a propósito el
  `.claude/settings.json` del repo). Mantén `"$defaults"` o reemplazas las
  reglas integradas por completo:

  ```json
  {
    "autoMode": {
      "environment": ["$defaults", "Key internal services: the `sandbox` SQL Server instance at db-test.example.internal is a disposable test database, restored nightly from a fixture"],
      "allow": ["$defaults", "Schema changes on the `sandbox` database through the huginndb MCP connector are allowed: it holds no production data"]
    }
  }
  ```

- **O salir del modo auto** (Shift+Tab → Manual) y aprobar cada llamada a mano.

Nada de esto afloja el conector: su política se relee de disco en cada intento
de escritura y se aplica *después* de que el cliente haya aprobado la llamada,
así que una conexión dejada en `read-only` sigue siendo de solo lectura por
permisiva que sea la configuración del cliente. Esa asimetría es justamente el
punto — el cliente controla *a este asistente en esta máquina*, el nivel de
escritura controla *la base de datos*.

## Drivers soportados

PostgreSQL, MySQL, SQLite, MongoDB y Microsoft SQL Server — los mismos
drivers que la app de escritorio, mediante el mismo código de backend.

Las herramientas de lectura funcionan igual en todos, y también las de
escritura a nivel de fila (`insert_row`, `update_cell`, `delete_rows`).

El único hueco es `save_view` en SQL Server, cuyo generador de DDL T-SQL para
vistas todavía no existe: ahí devuelve un error de «driver no soportado». Todo
lo demás sobre vistas funciona en los cinco: `describe_table` informa de la
definición de una vista en todos los drivers, y `drop_view` funciona en todos.

`create_index` y `drop_index` son solo de MongoDB y devuelven un error de
«driver no soportado» en el resto; `list_indexes` lee en los cinco. Ver
[Índices: por qué las dos herramientas de escritura son solo de
MongoDB](#índices-por-qué-las-dos-herramientas-de-escritura-son-solo-de-mongodb).

No hay herramienta para editar la estructura de una *tabla* en ningún driver.
Se dejó fuera a propósito (ver
[`MCP_CONNECTOR_ROADMAP.md`](MCP_CONNECTOR_ROADMAP.md)): hacer que un asistente
sintetice una lista de columnas completa, con tipos, nulabilidad, valores por
defecto y claves, es peor que hacerle emitir `ALTER TABLE` por `run_query`, que
`full` permite. Ese argumento va del *tamaño del DTO*, y por eso no se traslada
a los índices de MongoDB: la especificación de un índice es un documento de
claves y un puñado de flags, más cerca de `save_view` que de una tabla.

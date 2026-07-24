# Registro de cambios

Todos los cambios relevantes de HuginnDB se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y el proyecto se adhiere a [Versionado Semántico](https://semver.org/lang/es/) a partir de la `1.0`.

> Nota: este archivo es la traducción al español de `CHANGELOG.md`. Cubre las versiones recientes; las versiones más antiguas se muestran en inglés dentro de la app hasta que se traduzcan.

## [Unreleased]

### Cambiado

- **«Sacar a ventana flotante» ahora abre una ventana del sistema operativo
  real e independiente.** La acción de una pestaña llamaba antes a
  `addFloatingGroup` de dockview, que solo separa el panel *dentro* de los
  límites del propio espacio de trabajo interno — el panel flotante se podía
  arrastrar, pero nunca más allá de los bordes del panel de workspace del que
  salía, lo cual frustraba el propósito cuando lo que se quería era, por
  ejemplo, tener el editor de celda completamente fuera de la vista de la
  tabla. Ahora abre una `WebviewWindow` nativa y desnuda (`open_tab_window`,
  renderizada por la nueva raíz `DetachedTabWindow`) que aloja únicamente esa
  pestaña — sin barra lateral, sin otras pestañas, sin menús — y se puede
  mover a cualquier parte del escritorio como cualquier otra ventana. La
  pestaña se elimina del workspace de la ventana principal en el momento en
  que se saca, así que cerrar la ventana flotante es simplemente el cierre de
  la pestaña: no queda ningún estado que reconciliar de vuelta. Aplica a
  todos los tipos de pestaña (tabla, query, estructura, vista, seguridad).
  Igual que «Nueva ventana», estas ventanas son efímeras — no tocan
  `tab_state.json` ni se restauran entre reinicios.

## [1.10.0] — 2026-07-23

### Añadido

- **Las vistas ya se pueden crear, editar, renombrar y eliminar desde el
  explorador de esquema (#86).** Hasta ahora una vista aparecía en el árbol
  en modo solo lectura — su menú contextual solo ofrecía Abrir / Copiar
  nombre / Copiar SELECT / Refrescar, con toda acción DDL explícitamente
  bloqueada (`!isView` en `SchemaExplorer.tsx`), y el backend ni siquiera
  tenía una consulta para leer la definición de una vista (`pg_get_viewdef`
  / `information_schema.views` / `sqlite_master.sql` nunca se llamaban). La
  única forma de tocar una vista era escribir a mano `CREATE OR REPLACE
  VIEW` en el editor de consultas — exactamente la experiencia de SQL en
  crudo al estilo HeidiSQL que el mantenedor quería evitar, sobre todo en
  vistas con varios JOIN donde es difícil saber qué columnas/filas produce
  realmente la definición solo leyendo el SQL. En vez de construir un
  constructor visual de consultas/joins completo (punto 9 del roadmap,
  explícitamente de baja prioridad), la nueva pestaña «Editar vista…»
  combina un editor Monaco a tamaño completo para el cuerpo de la vista —
  con el mismo autocompletado consciente del esquema que el editor de
  consultas — con una rejilla de «previsualización de resultados» en vivo
  y con debounce que ejecuta el borrador actual (envuelto en un `SELECT`
  externo con `LIMIT`) para que las columnas y filas reales que produce un
  JOIN sean visibles mientras se escribe, más un panel de DDL de solo
  lectura (mismo patrón que el editor de estructura de tabla) que muestra
  las sentencias exactas que ejecutará Aplicar. Cinco nuevos comandos de
  Tauri (`get_view_definition`, `preview_view_change`, `apply_view_change`,
  `rename_view`, `drop_view`) siguen la misma forma que los ya existentes
  `get_table_structure`/`preview_structure_change`/`apply_structure_change`.
  MongoDB queda excluido en esta versión, igual que la edición de
  estructura de tabla — sus «vistas» son colecciones de agregación de solo
  lectura con un modelo de edición fundamentalmente distinto
  (`collMod`/`createView`).

- **Un operador `between` en el Filtro avanzado, unificando el filtrado por
  rango en todos los drivers (#81).** El constructor de filtro avanzado ya
  ofrecía `contains`/`not_contains`/`starts_with`/`ends_with` de forma
  consistente en Postgres, MySQL, SQLite y MongoDB (verificado al investigar
  este issue — el `contains` de MySQL ya funcionaba vía la ruta compartida
  `CAST(col AS CHAR) LIKE`), pero no existía ningún operador para filtrar un
  rango inclusivo en una sola condición; el usuario tenía que apilar una fila
  `gt`/`gte` y otra `lt`/`lte`. `FilterOp::Between` es ahora una única
  variante compartida consumida por `build_filter_clause` (SQL: `col BETWEEN
  ? AND ?` / `BETWEEN $N AND $N+1`) y por `build_filter` de Mongo (`{ $gte,
  $lte }`), respaldada por un nuevo campo `value2` en `ColumnFilter`
  (añadido tanto en el struct de Rust como en su espejo de TypeScript — un
  valor que serde descartaría en silencio si no, ver gotcha #14). El diálogo
  lo ofrece junto a `gt`/`gte`/`lt`/`lte` para columnas numéricas/de fecha y
  muestra un segundo input «hasta» al seleccionarlo.

- **Un clic ahora muestra un icono directo de «expandir» sobre la celda
  seleccionada, para ver su valor completo sin tener que hacer antes
  doble clic y entrar en modo edición (#78).** Antes la única forma de ver
  el contenido completo de una celda larga era hacer doble clic, lo que en
  una celda editable también entraba en modo edición inline — un efecto
  secundario no deseado cuando el usuario solo quería *leer* el valor. La
  rama plana (sin edición) del renderizador de celdas de `DataGrid` ahora
  comprueba si la celda coincide con `selectedCell` (fijado con un clic
  simple, comparado por la misma identidad referencial
  `rowValues`/`row.original` que se usa en el resto de la rejilla — ver
  gotcha #7) y, si es así, dibuja un pequeño botón `Maximize2` junto al
  valor. Al pulsarlo llama al ya existente `openHeavyEditor`, sin cambios,
  así que ya respeta la preferencia `cellEditorMode` del usuario (modal vs.
  panel lateral acoplado) igual que el propio botón de expandir del editor
  inline y el botón de pantalla completa del panel de previsualización de
  celda. El icono aparece de forma uniforme en columnas de texto, FK y BIT,
  y en resultados de consulta de solo lectura — es puramente un visor de
  valores, nunca un editor, así que no hace falta excluir ningún tipo de
  columna.

- **Ctrl+C / Ctrl+V ahora funcionan sobre la celda seleccionada de la
  rejilla de datos (#79).** `handleGridKeyDown` ignoraba deliberadamente
  cualquier combinación con Ctrl/Cmd (para no interferir con el copiar/pegar
  nativo del navegador), lo que hacía que Ctrl+C sobre una celda no copiara
  nada, ya que un `<td>` no tiene selección de texto nativa que copiar.
  Ctrl+C y Ctrl+V ahora tienen un caso especial antes de ese bloqueo
  general: Ctrl+C copia el valor en crudo de la celda seleccionada con el
  ratón (recurriendo a la celda activa navegada con teclado si no se ha
  clicado ninguna) mediante el mismo helper `copyToClipboard` que ya usa el
  «Copiar» del menú contextual de clic derecho. Ctrl+V lee
  `navigator.clipboard` y siembra `inlineEdit` con el texto pegado en vez
  del valor actual de la celda — reutilizando exactamente el mismo flujo de
  confirmar/cancelar de `CellInput` que una edición normal por doble clic,
  así que Enter/blur guarda el valor pegado y Escape lo descarta. Las
  columnas FK y BIT no tienen un control de texto libre en el que pegar
  (usan un combobox / `<select>`), así que pegar es, por ahora, un no-op
  deliberado ahí; copiar sigue funcionando en todos los tipos de columna.

- **Los atajos de teclado ya se pueden personalizar desde Ajustes → Atajos
  (#75), desbloqueando la mitad «atajo de teclado» del #78.** El issue #78
  pedía una alternativa por atajo al icono de expandir añadido arriba, ya
  que el bajo contraste del icono hace fácil pasarlo por alto — pero eso se
  dejó explícitamente para el #75. Ahora hay seis acciones reasignables:
  `openSettings` (Ctrl/Cmd+,), `toggleCommandPalette` (Ctrl/Cmd+K),
  `toggleTabSwitcher` (Ctrl/Cmd+P), `refreshData` (F5 — Ctrl/Cmd+R se
  mantiene como alias permanente no reasignable, ya que suprimir la
  recarga nativa del WebView es una necesidad de seguridad, no una
  preferencia), `runQuery` (Ctrl+Enter), y el nuevo `expandSelectedCell`
  (por defecto `Espacio`, imitando el Quick Look de macOS — confirmado sin
  usar en `handleGridKeyDown` hasta ahora, así que llega sin colisión
  alguna). Los cambios persisten en `prefs.json` como un nuevo mapa
  `keybindings` (id de acción → combinación), siguiendo el mismo patrón ya
  usado por las preferencias `grid`/`editor`/`ui` — un mapa vacío es un
  estado totalmente válido, ya que la nueva tabla `ACTIONS` de
  `lib/keybindings.ts` en el frontend es la única fuente de verdad para los
  valores por defecto. El listener global `keydown` de `App.tsx` y el
  `handleGridKeyDown` de `DataGrid` ahora comparan contra el atajo activo
  mediante un helper compartido `matchesBinding` en vez de comprobaciones
  fijas de `e.key`/`e.ctrlKey` — lo que de paso corrige un bug latente
  donde `Ctrl+Shift+K` era indistinguible de un simple `Ctrl+K` (ninguna
  rama comprobaba `shiftKey`). El `editor.addCommand` de Monaco, usado para
  `runQuery`/`toggleCommandPalette`/`toggleTabSwitcher` dentro de los
  editores de SQL y de vista, resuelve una máscara de atajo fija una sola
  vez al registrarse, sin forma de volver a comprobar una combinación en
  vivo — así que esos tres pasaron a `editor.onKeyDown`
  (`registerEditorActionRedispatch` en el nuevo `lib/monacoKeybindings.ts`),
  que lee el atajo activo desde el store en cada pulsación. La UI de
  Ajustes (`ShortcutsSection`/nuevo `ShortcutRow`) sustituye el antiguo
  marcador de posición de solo lectura: al hacer clic en una fila entra en
  modo captura «pulsa una tecla…» (Escape siempre cancela en vez de
  convertirse en el atajo), una reasignación que choca con la combinación
  de otra acción se rechaza en el sitio en vez de intercambiar o
  desvincular nada en silencio, y cada fila más un botón «Restablecer
  todo» pueden volver al valor por defecto. `expandSelectedCell` reutiliza
  exactamente el mismo par `resolveTargetCell()`/`openHeavyEditor()` que ya
  llama el manejador de clic del icono de expandir, así que el icono y el
  atajo convergen en una única ruta de escalado. También se subió el
  contraste de ambos iconos de expandir (`DataGrid`/`CellInput`) de
  `text-muted-foreground/50` a `/80` para que el icono añadido en el #78
  no necesite hover para notarse.

### Corregido

- **Las columnas espaciales de MySQL (`POINT`, `MULTIPOINT`, …) se
  clasificaban erróneamente como numéricas en el Filtro avanzado**, porque
  la comprobación de subcadena `"int"` de `isNumericType` también coincide
  dentro de la palabra `"point"`. Esas columnas perdían
  `contains`/`starts_with`/`ends_with` y ganaban comparaciones `>`/`<` sin
  sentido. Encontrado al auditar la unificación de operadores para el #81;
  corregido excluyendo la subcadena `"point"` de la comprobación de
  `"int"`.

- **Las herramientas de escritura del conector MCP podían quedar forzadas
  a solo lectura para una base de datos MongoDB sobre la que tenían acceso
  explícito `data`/`full`.** Reportado por un usuario que recibía `has MCP
  write policy "read-only"` en `update_cell` contra una conexión cuyo nivel
  en Ajustes → MCP era en realidad `data`. La comprobación de escritura
  (`Huginn::require_class`) verificaba la política contra el id de pool
  *resuelto* de `resolve_mongo_target` en vez del id de perfil real. En una
  conexión Mongo multi-base de datos (con `database` de nivel superior
  vacío — el caso habitual, ya que HuginnDB no obliga a elegir una base de
  datos al conectar), una llamada de herramienta que nombra un
  `schema`/`database` se resuelve al id sintético por base de datos
  `<connection_id>::db::<name>` para poder dirigirse al pool correcto en
  vivo — pero ese id sintético nunca es una clave en `profiles.json`, así
  que la búsqueda de política fallaba en silencio y caía al valor por
  defecto `ReadOnly`, sin importar cómo estuviera configurada realmente la
  conexión. `run_query`, `insert_row`, `update_cell` y `delete_rows` ahora
  verifican contra `a.connection_id` (el id de perfil real) en vez del
  destino resuelto; el destino resuelto se sigue usando, como antes, para
  encontrar el pool correcto. Se añadió una prueba de regresión que
  reproduce el escenario exacto (una conexión Mongo con política `data` y
  sin base de datos por defecto, direccionada vía `schema`).

- **`updateMany`/`updateOne` rechazaban una actualización con pipeline de
  agregación (`db.coll.updateMany(filtro, [{ $set: {...} }])`)** con
  `argument 2 must be a document`, aun cuando el driver `mongodb`
  subyacente soporta actualizaciones estilo pipeline desde el servidor
  4.2. El parser al estilo mongosh (`db/mongo/shell.rs`) solo construía un
  `Document` plano para el argumento `update`. Ahora acepta ambas formas —
  un nuevo enum `UpdateSpec` (`Document` | `Pipeline`) que refleja
  `mongodb::options::UpdateModifications` — así que las actualizaciones
  con pipeline (por ejemplo, `$replaceAll`/`$toUpper`/valores de campo
  calculados que referencian otros campos) funcionan a través de
  `run_query` igual que en `mongosh`.

### Seguridad

- **Verificación manual de extremo a extremo de la política de escritura
  del conector MCP contra un conjunto real de perfiles, usando un cliente
  de IA real (Claude Code operando `huginndb-mcp`) en vez de una prueba
  unitaria.** Primero se llamó a `list_connections`, de solo lectura (sin
  tocar ningún estado): de cada conexión expuesta — incluidas bases de
  datos de producción y sandboxes reales de clientes — exactamente una (un
  servidor de pruebas interno de ITBacking) tenía `mcp_write: "data"`;
  todas las demás conexiones estaban en el valor por defecto seguro
  `read-only`, tal como garantiza `McpWritePolicy::default()`
  (`state.rs`) para cualquier perfil al que nunca se le subió el nivel
  explícitamente en Ajustes → MCP. Después se intentó una llamada
  `insert_row` contra esa única conexión con política `data`, sobre una
  tabla de configuración sin relación con datos de clientes (sin datos de
  cliente, sin claves foráneas) — el objetivo de menor riesgo disponible —
  como comprobación completa de ida y vuelta (insertar, verificar,
  actualizar, borrar, sin dejar residuo). La escritura nunca llegó a
  `Huginn::require_class`: la propia capa de permisos de herramientas de
  Claude Code (el cliente que conduce la sesión MCP, no código de este
  repositorio) interceptó la llamada y la retuvo pendiente de autorización
  explícita del usuario, aunque la política del lado del servidor la
  habría permitido. Esto confirma que las dos barreras son independientes
  y ambas están intactas — una política `mcp_write` permisiva por conexión
  es necesaria pero no suficiente; el propio aviso de aprobación de
  acciones del cliente de IA que llama es una segunda barrera separada, no
  una intercambiable/redundante. No hubo cambios de código; esto es una
  entrada de checklist de release, no una corrección.

## [1.9.1] — 2026-07-22

### Corregido

- **Ejecutar un único INSERT/UPDATE/DELETE no mostraba ningún resultado (#82).**
  La ruta de sentencia única del editor de consultas (`Ctrl+Enter`) enviaba un
  resultado DML sin columnas directamente a `DataGrid`, que no tiene nada que
  dibujar para ese caso — el panel de resultados simplemente parecía vacío, sin
  error ni recuento de filas. Solo la ruta de lote multi-sentencia mostraba un
  resumen de «filas afectadas». Ahora un resultado DML (sin columnas) muestra
  un pequeño aviso «N filas afectadas · Xms» en su lugar, en todos los drivers
  SQL — esto no era específico de MySQL, solo más probable de notar ahí.

- **Las herramientas de escritura del conector MCP podían hacer que nuevas
  sesiones cliente vieran cero herramientas (#83).** Las herramientas de modo
  escritura añadidas para `insert_row`, `update_cell` y `delete_rows`
  introdujeron formas de JSON-schema nunca usadas antes en la salida
  `tools/list` de este servidor: una estructura anidada elevada a `$defs`/`$ref`,
  y campos de valor de PK cuyo esquema por elemento era el booleano desnudo
  `true` (la representación de schemars para «cualquier valor JSON»). Ambas son
  JSON Schema válido, pero un cliente MCP cuya ingestión de `tools/list` asume
  que cada nodo de esquema es un objeto plano puede lanzar una excepción con
  ellas — y si esa ingestión envuelve toda la lista de herramientas en un único
  try/catch, un solo esquema mal formado para ese cliente descarta
  silenciosamente las 12 herramientas de la sesión, mientras que el propio log
  del servidor (que solo refleja lo que envió) parece perfectamente sano. Los
  esquemas de las tres herramientas ahora están en línea y restringidos a mano
  a `string | number | boolean | null`, con una prueba de regresión que
  verifica que ningún subesquema `$ref`/`$defs`/booleano desnudo vuelva a
  aparecer.

- **Expandir una base de datos con el mismo nombre bajo una conexión distinta
  podía filtrar los datos de la conexión anterior (#76).** El árbol de esquema
  multi-base de datos indexaba sus nodos `DatabaseRoot` solo por el nombre de
  la base de datos; como nada vuelve a montar ese árbol cuando cambia la
  conexión activa, React reutilizaba la misma instancia de componente — y su
  id de pool cacheado localmente — para dos conexiones distintas que ambas
  exponían una base de datos con el mismo nombre (por ejemplo, una base
  `shop` tanto en un perfil MySQL como en uno de MongoDB). El nodo de la
  segunda conexión seguía mostrando las tablas de la primera. El nodo ahora se
  indexa por conexión + nombre de base de datos juntos, así que cambiar de
  conexión siempre obtiene una instancia nueva.

- **La disposición de ventana/paneles y las ediciones de pestañas en curso
  podían perderse al cerrar (#80).** Ningún hook de cierre de ventana llegaba
  a volcar a disco el estado de pestañas/disposición con debounce, y un simple
  gesto de dividir/flotar/redimensionar no programaba un guardado en absoluto
  (solo lo hacía un cambio de pestaña o de esquema) — así que un cierre normal
  de ventana, no solo un cuelgue, podía perder los últimos ~600ms de cambios,
  incluida la geometría de paneles divididos configurada momentos antes.
  Cerrar la ventana principal ahora vuelca de forma síncrona el estado de
  pestañas de cada conexión activa primero, y los cambios de disposición
  programan un guardado igual que ya lo hacían los cambios de pestaña.

- **La actividad de MongoDB nunca llegaba a la consola.** Tanto explorar una
  colección (`fetch_table_data`) como ejecutar un lote multi-sentencia de
  mongosh (`execute_batch`) delegaban directamente en el módulo del driver
  de Mongo sin llegar a construir nunca una entrada de log — a diferencia de
  la ruta de sentencia única y de insertar/actualizar/eliminar, que ya
  registraban correctamente. Todos los demás drivers registraban cada
  lectura y escritura; MongoDB solo registraba escrituras emitidas de una en
  una. Ahora explorar una colección registra una línea reconstruida
  `db.<colección>.find(filtro).sort().skip().limit()` (no hay una sentencia
  literal que repetir, como sí la hay cuando el usuario la escribe a mano), y
  cada sentencia de un lote de mongosh se registra individualmente, igual
  que en la ruta de lote SQL.

- **El constructor de filtro avanzado devolvía silenciosamente cero
  resultados en MongoDB al filtrar un campo numérico (o booleano).** El chip
  «Filtrar por este valor» del menú contextual envía el valor de la celda ya
  tipado (por ejemplo, el número JS `183`), pero el campo de valor del
  diálogo de filtro avanzado es una casilla de texto plano — siempre enviaba
  el texto introducido como una cadena JSON. Postgres/MySQL/SQLite no lo
  notan: el tipo de un parámetro sin tipar se infiere de la columna con la
  que se compara, así que un texto `"183"` sigue coincidiendo con una
  columna `integer`. La igualdad de MongoDB, en cambio, es de tipo BSON
  exacto, y un `string` `"183"` nunca coincide con un `int32` 183
  almacenado — así que el mismo filtro que funcionaba desde el menú
  contextual devolvía cero filas desde el diálogo. El diálogo ahora convierte
  el valor introducido a número/booleano según el tipo de la columna antes
  de aplicar el filtro (los operadores de coincidencia de subcadena —
  contiene/empieza por/termina en — conservan el texto tal cual, ya que
  esos siempre son una coincidencia de texto/regex independientemente del
  tipo de columna).

## [1.9.0] — 2026-07-20

### Corregido

- **Los logs de la consola se filtraban entre ventanas (#50).** Con una segunda
  ventana abierta (acción «Nueva ventana»), la consola de cada ventana mostraba
  las entradas SQL y de conexión de todas las demás. El backend ya dirigía los
  eventos de log a la ventana de origen, pero el listener del frontend no estaba
  acotado, así que Tauri los entregaba a todas las ventanas. Ahora la consola de
  cada ventana muestra solo su propia actividad; los avisos realmente globales
  (como la caída de una conexión compartida) siguen llegando a todas.
  
- **Las columnas booleanas de MySQL mostraban `NULL` en vez de su valor (#68).**
  Una columna `TINYINT(1)` / `BOOL` / `BOOLEAN` la reporta el driver con el
  nombre de tipo `BOOLEAN`, que el decodificador de valores no reconocía como
  entero — así que cada celda booleana caía a una decodificación de texto no
  válida para la columna y colapsaba a `NULL`. Las columnas booleanas ahora
  muestran su valor almacenado (`0` / `1`), como cualquier otro entero.
  
### Añadido

- **Filtro avanzado por columna (#66).** Un nuevo botón de filtro en la barra
  de la cuadrícula abre un constructor donde añades condiciones por columna —
  columna → operador → valor — combinadas con AND y aplicadas en el servidor.
  Los operadores dependen del tipo: las columnas de texto ofrecen contiene /
  no contiene / empieza por / termina en, las numéricas y de fecha ofrecen
  comparaciones (>, ≥, <, ≤), y todas ofrecen igual / distinto / es nulo / no
  es nulo. Funciona en Postgres, MySQL, SQLite (`LIKE`/comparaciones SQL) y
  MongoDB (regex / `$gt`…`$lt`). El botón muestra un contador de condiciones
  activas.

- **Vaciar una tabla desde el explorador de esquema (#69).** Una nueva entrada
  «Vaciar tabla» en el menú contextual de una tabla (o colección de MongoDB)
  elimina todas las filas conservando la tabla y su estructura — útil para
  tablas usadas como log. Usa `TRUNCATE` en Postgres/MySQL, `DELETE FROM` en
  SQLite y `deleteMany({})` en MongoDB. Un diálogo de confirmación protege la
  acción e incluye una casilla «no volver a preguntar» respaldada por una
  preferencia dedicada `confirmEmptyTable`, para que silenciarla no debilite
  otras confirmaciones destructivas.

- **Modo escritura del conector MCP, con un modelo de permisos por conexión.**
  El conector headless `huginndb-mcp`, de solo lectura desde la 1.7.0, ya puede
  realizar escrituras — gobernadas por conexión, no por un único interruptor
  global. Cada conexión tiene un **nivel de escritura** configurado en Ajustes
  → MCP:
  - `read-only` (por defecto) — solo lecturas;
  - `data` — añade DML a nivel de fila (`INSERT`/`UPDATE`/`DELETE`) vía
    `run_query` y las nuevas herramientas `insert_row` / `update_cell` /
    `delete_rows`;
  - `full` — permite además DDL (`CREATE`/`DROP`/`ALTER`/…) vía `run_query`.

  El nivel se relee de `profiles.json` en cada intento de escritura, así que
  cambiarlo surte efecto sin reiniciar el cliente de IA. Como el sidecar es un
  proceso headless que no puede mostrar un prompt, la aprobación por acción la
  da el cliente MCP, y HuginnDB registra cada escritura (éxito o fallo) en
  `mcp-audit.log` junto a tus perfiles. Un `UPDATE`/`DELETE` sin `WHERE` sobre
  toda la tabla se rechaza de plano, y un nuevo flag `--read-only` fuerza todas
  las conexiones a solo lectura sin importar su nivel guardado. El antiguo flag
  `--allow-writes` queda obsoleto e inerte. Ver [`docs/MCP.es.md`](docs/MCP.es.md).

## [1.8.3] — 2026-07-16

### Añadido

- **Crear una colección de MongoDB desde el explorador (#61).** MongoDB crea
  la colección de forma implícita en la primera escritura, así que no había
  manera de materializar una colección vacía desde la interfaz — tenías que
  insertar un documento antes. Ahora hay una entrada "Nueva colección" en el
  menú contextual de la base de datos MongoDB (y un botón "+" en la barra de la
  base de datos, igual que el "Nueva base de datos" de Postgres/MySQL), que
  emite un comando `create` explícito mediante un nuevo comando de backend
  `create_collection`, de forma que la colección aparece en el árbol antes de
  que exista ningún documento, como en MongoDB Compass. El nombre se valida
  (no vacío, sin el prefijo reservado `system.`); los drivers no-Mongo se
  rechazan (crean tablas a través del editor de estructura).
- **Elegir qué bases de datos muestra una conexión, al estilo DataGrip
  (#64).** Una conexión multi-base listaba *todas* las bases del servidor y
  precargaba sus tablas en segundo plano — ruidoso y lento en servidores con
  decenas de bases. Una nueva lista de selección (el botón de casillas en la
  cabecera del explorador multi-base) permite elegir el subconjunto con el que
  realmente trabajas; el explorador muestra solo esas. La elección se guarda
  por conexión (`visible_databases` en el perfil; `null` = mostrar todas, de
  modo que las bases nuevas siguen apareciendo). Aplica a Postgres/MySQL y a
  clústeres MongoDB por igual.
- **Importar y exportar colecciones de MongoDB como JSON (#65).** La
  exportación de base de datos completa (`.sql`) nunca soportó MongoDB. Ahora
  cada colección tiene "Exportar colección (JSON)…" / "Importar JSON…" en su
  menú contextual, usando **Extended JSON canónico de MongoDB**, de modo que
  `ObjectId`/`Date`/`Decimal128`/… conservan su tipo en el viaje de ida y
  vuelta (a diferencia de la forma de visualización que muestra la rejilla). La
  exportación transmite directamente desde el cursor al fichero; la importación
  acepta un array JSON, un único objeto, o JSON por líneas (el formato por
  defecto de mongoexport) e inserta el lote tras una confirmación destructiva.

### Cambiado

- **El título de la ventana del sistema ahora refleja la conexión y la tabla
  activas (#57, #59).** Cada ventana se titulaba con un "HuginnDB" fijo, lo que
  hacía imposible distinguir varias ventanas desde la barra de tareas / Alt-Tab.
  El título muestra ahora `<perfil> · <base>.<tabla> — HuginnDB` para la pestaña
  de tabla activa (cayendo a `<perfil> · <base>` en otras pestañas, y a
  "HuginnDB" a secas cuando no hay conexión), y las pestañas de tabla se
  etiquetan `base.tabla` en vez de solo el nombre de la tabla, así la base y la
  tabla se ven siempre juntas. Se ha quitado el breadcrumb redundante
  `esquema › tabla` que aparecía junto al filtro de la rejilla — el título de la
  pestaña ya lleva esa identidad. Las ventanas secundarias quedan cubiertas por
  la configuración de capacidades (`win-*`).
- **Conectar a un servidor con muchas bases es ahora instantáneo — el
  explorador ya no precachea las tablas de todas las bases al conectar.** El
  explorador multi-base precargaba en segundo plano la lista de tablas de
  *cada* base justo tras conectar, así que una conexión con 19+ bases se quedaba
  un momento en "Cacheando esquema… n/m" antes de asentarse. Esa precarga solo
  era una optimización de búsqueda y ahora es redundante con el selector de
  bases visibles (#64) y el ámbito de base activa: las bases se cargan de forma
  perezosa al expandirlas, y la búsqueda entre bases sigue haciendo el fan-out
  bajo demanda la primera vez que buscas. Efecto neto: conectar es inmediato
  independientemente de cuántas bases tenga el servidor; el único coste es que
  la primera búsqueda entre bases tras conectar se sirve "en frío".

## [1.8.2] — 2026-07-15

### Añadido

- **El auto-actualizador ahora se pone al día con releases publicados
  mientras la app sigue abierta, en vez de comprobar solo al arrancar.**
  `checkOnLaunch` era el único disparador — una instancia que nadie cierra
  nunca (un equipo compartido, un puesto que no se reinicia) podía quedarse
  en la versión anterior indefinidamente por muchos releases que se
  publicaran, porque nunca faltaba publicar, faltaba que la app volviera a
  preguntar. Un nuevo `startPeriodicChecks` (`src/stores/update.ts`) repite
  la misma comprobación cada 4 horas mientras la app siga en ejecución, así
  que una instancia de larga duración acaba enterándose sola. Junto con
  esto, la descarga del instalador ahora empieza en silencio en cuanto se
  detecta una actualización (`startBackgroundDownload`), así que cuando
  alguien repara en el aviso, instalar es instantáneo en vez de esperar una
  descarga. Lo único que esto deliberadamente NO automatiza es el propio
  `install()` — el paso que sobrescribe archivos, mata a la fuerza el
  sidecar `huginndb-mcp` (gotcha #23) y puede pedir elevación a Windows —
  que solo se ejecuta tras un clic explícito en "Instalar" / "Reiniciar
  ahora", nunca sin supervisión. Un nuevo estado `readyToRestart` distingue
  "descargada, a un clic de terminar" de "todavía descargando" tanto en el
  banner superior como en Ajustes → Acerca de. Como instalar mata el
  sidecar de MCP, `installAndRelaunch` también comprueba si sigue en
  ejecución (un nuevo comando de Tauri `is_mcp_sidecar_running` — un
  `tasklist`/`pgrep` según plataforma, sin dependencia nueva) y, si es así,
  pide confirmación al usuario antes de cortar de golpe una conexión que un
  cliente de IA podría estar usando en ese momento.
- **Se documentan Cursor y Antigravity como clientes MCP, y se mejora la
  lista de conexiones de Ajustes → MCP.** `huginndb-mcp` es un servidor MCP
  estándar sobre stdio sin código específico por cliente, así que ya
  funcionaba con cualquier cliente compatible con la especificación —
  incluidos Cursor y el IDE Antigravity de Google — pero `docs/MCP.md` solo
  detallaba Claude Code, Claude Desktop y Codex, dejando a quienes usan otros
  IDEs agénticos adivinando la ubicación del archivo de configuración y el
  formato JSON. Se añaden secciones dedicadas para ambos: el
  `.cursor/mcp.json` (de proyecto) / `~/.cursor/mcp.json` (global) de Cursor,
  y el flujo de Antigravity desde la UI ("Manage MCP Servers → View raw
  config") — ambos documentados con la misma forma
  `mcpServers`/`command`/`args` que ya genera el panel de Ajustes → MCP de la
  app, así que el snippet JSON existente se pega tal cual. Por separado, la
  lista de conexiones en Ajustes → MCP ahora tiene un filtro por nombre y un
  botón "seleccionar todas / deseleccionar todas" (limitado a las filas
  filtradas en cada momento), más un contador en vivo de "n de m
  seleccionadas" — la lista plana de checkboxes no escalaba bien pasado un
  puñado de conexiones guardadas.
- **`docs/MCP.md` tiene ahora una traducción al español mantenida
  (`docs/MCP.es.md`).** El visor de documentación integrado (Ayuda →
  Documentación) incluía la guía de MCP solo en inglés, sin importar el
  idioma de la UI elegido por el usuario — inconsistente con el resto de la
  app, que ya distribuye cadenas en español completas y un
  `CHANGELOG.es.md`. `src/lib/docs.ts` mantiene ahora un mapa `bodies` por
  idioma en cada entrada de documento (el inglés siempre presente) y
  `getDocBody` recurre al inglés cuando falta una traducción, siguiendo el
  mismo patrón que `getReleases` en `lib/changelog.ts` — el mismo contrato de
  "inglés autoritativo, el español puede ir por detrás" que ya usa el
  changelog.

## [1.8.1] — 2026-07-15

### Corregido

- **Actualizar en Windows mientras un cliente MCP tenía abierto el sidecar
  `huginndb-mcp` podía fallar con un error de permisos que no era tal.** El
  instalador NSIS se mantiene en el modo de instalación por defecto de Tauri
  (`currentUser`, escribe bajo `%LOCALAPPDATA%`, sin necesitar elevación) y
  cierra correctamente `huginndb.exe` si está en ejecución antes de
  sobrescribirlo — pero no tenía forma de saber que `huginndb-mcp.exe`
  existe, ya que ese proceso lo arranca de forma independiente el cliente MCP
  externo que lo tenga configurado (Claude Desktop, Claude Code…), nunca la
  propia HuginnDB. Si un cliente lo mantenía abierto durante una actualización
  desde la app, Windows bloqueaba el archivo y la sobrescritura fallaba con
  `ERROR_SHARING_VIOLATION`, mostrado al usuario como un error genérico de
  acceso denegado aunque no faltaban permisos de administrador reales. Un
  nuevo hook de instalación `NSIS_HOOK_PREINSTALL`
  (`src-tauri/windows/hooks.nsi`) cierra ahora el sidecar por la fuerza antes
  de copiar ningún archivo; el cliente MCP simplemente lo vuelve a lanzar la
  próxima vez que lo necesite.
- **`huginndb-mcp` rechazaba conexiones SQLite y MongoDB sin contraseña con
  "no stored password for keychain account ...::".** El helper
  `resolve_password` de la app de escritorio ya sabe que SQLite nunca
  guarda contraseña (no hay nada que autenticar — es un archivo local) y que
  en MongoDB es opcional (puede venir embebida en el URI de conexión, o el
  servidor puede permitir acceso sin autenticación), devolviendo una cadena
  vacía en ambos casos. El `ensure_connected` del servidor MCP nunca
  reutilizaba ese helper — llamaba directamente a
  `keychain::require_password`, así que cualquier conexión SQLite o MongoDB
  con URI sin credenciales expuesta a un cliente MCP fallaba en cada llamada
  con un error de "credencial ausente" que no era real. Ahora usa el mismo
  `resolve_password` que la app de escritorio.

## [1.8.0] — 2026-07-14

### Corregido

- **El panel de Seguridad de MongoDB funciona en conexiones multi-base de
  datos.** El fix de 1.7.0 para #52 enseñó a `list_collections` a devolver una
  lista vacía a nivel de clúster en vez de dar error, pero `list_users`/
  `list_privileges` nunca se actualizaron igual — abrir la pestaña de
  Seguridad en una conexión MongoDB sin base preseleccionada seguía lanzando
  "no database selected". Ambas funciones ahora operan a nivel de clúster vía
  el comando `usersInfo` con `forAllDBs: true` contra la base `admin` cuando no
  hay base seleccionada (el mismo patrón a nivel de clúster que ya usaba el
  chequeo de salud de la conexión), manteniendo el comportamiento actual por
  base de datos en el resto de casos.
- **El `run_query` del MCP ya no rechaza cualquier consulta de MongoDB.** El
  filtro de solo-lectura reutilizaba el clasificador de palabras clave SQL
  (`select`/`with`/`show`/`explain`/`pragma`), que una sentencia mongosh como
  `db.coll.find({...})` nunca cumple — así que cualquier lectura de MongoDB
  enviada a través de la tool `run_query` de `huginndb-mcp` se rechazaba por
  defecto, y la única vía de escape era el flag global `--allow-writes` (que
  además desbloquea escrituras SQL reales en cualquier otra conexión
  expuesta). El editor de consultas de escritorio nunca tuvo este problema
  porque clasifica las sentencias Mongo con `MongoOp::is_read()` antes de que
  se ejecute el filtro genérico; `run_query` ahora hace lo mismo.
- **Las tools del MCP ya pueden apuntar a una base concreta en una conexión
  MongoDB multi-base.** `list_tables`, `describe_table`, `list_indexes` y
  `browse_table` aceptaban un parámetro `schema` que se ignoraba por completo
  para MongoDB — cualquier llamada sobre una conexión sin base seleccionada
  fallaba con "no database selected", sin ninguna forma de indicar qué base
  usar, y `run_query` no tenía forma de apuntar a una base para un
  `db.coll.find()` suelto. La app de escritorio resuelve el mismo problema
  abriendo un pool sintético por base cuando el usuario expande una base en
  el explorador de esquema; esa lógica no necesitaba `AppHandle`/`Window` de
  Tauri para empezar, así que ahora se comparte con el servidor MCP, que
  resuelve el mismo pool por base siempre que `schema` (o el nuevo parámetro
  `database` de `run_query`) indique una base sobre una conexión sin
  ninguna vinculada.
- **`limit`/`offset` de `browse_table` aceptan también un string numérico.**
  Algunos clientes MCP serializan los argumentos enteros como strings JSON
  pese al esquema anunciado; ambos campos ahora admiten tanto un número JSON
  como un string numérico en vez de rechazar la llamada directamente.

### Añadido

- **Tipos BSON reales por columna en los resultados de consulta/exploración de
  MongoDB.** `run_query`, `browse_table` y la grid de datos etiquetaban toda
  columna con el tipo genérico `"bson"`, aunque cada campo tiene un tipo BSON
  concreto. Las columnas ahora reportan el tipo real inferido a partir de los
  documentos/valores devueltos (`int`, `string`, `date`, `objectId`, …),
  cayendo a `"mixed"` cuando los valores no nulos de un campo discrepan de
  tipo dentro del mismo resultado — una respuesta honesta en vez de elegir uno
  en silencio. Esto también da a las herramientas de IA que usan el conector
  MCP una señal de tipo real en vez de ninguna.
- **Tamaño de colección en el explorador de MongoDB.** Las colecciones antes
  siempre mostraban un tamaño desconocido. Una sola agregación `$collStats` a
  nivel de base de datos ahora devuelve las estadísticas de almacenamiento de
  todas las colecciones en una sola llamada (en vez de un `collStats` por
  colección), de forma que el explorador puede mostrar un tamaño en disco
  igual que ya hacen los drivers SQL.

## [1.7.1] — 2026-07-14

### Añadido

- **`huginndb-mcp` ahora viene incluido en el instalador, y Preferencias tiene
  un panel de MCP.** Antes el conector solo era accesible clonando el repo y
  compilándolo uno mismo — ningún instalador empaquetado incluía el binario.
  Ahora es un sidecar de Tauri (`bundle.externalBin`), instalado junto al
  ejecutable principal, y el workflow de release lo compila y coloca
  automáticamente. **Preferencias → MCP** resuelve esa ruta, deja elegir qué
  conexiones guardadas exponer, y genera un snippet `claude mcp add`/JSON
  listo para pegar — sin tener que rebuscar rutas de instalación ni ids de
  conexión en `profiles.json` a mano. Ver [`docs/MCP.md`](docs/MCP.md).

## [1.7.0] — 2026-07-14

### Añadido

- **Conector MCP (`huginndb-mcp`).** Un servidor [Model Context
  Protocol](https://modelcontextprotocol.io) headless y de solo lectura que
  expone a herramientas de IA (Claude Code, Claude Desktop, Cursor, …) las bases
  de datos que HuginnDB ya conoce —perfiles de `profiles.json`, contraseñas del
  llavero del sistema— por stdio, para que el asistente inspeccione el esquema y
  los datos reales en lugar de adivinar. Es un proceso independiente de la app de
  escritorio, abre los pools de forma perezosa y es **opt-in por perfil**
  (`--connections <id>`): no expone nada hasta que lo nombras. Solo lectura por
  defecto (`run_query` rechaza SQL que no sea de lectura; sin herramientas de
  escritura), con un tope `--max-rows` (1000 por defecto). Diez herramientas:
  `list_connections`, `list_databases`, `list_tables`, `describe_table`,
  `list_indexes`, `run_query`, `browse_table`, `server_version`, `list_users`,
  `list_privileges`. Se compila tras una feature de cargo opcional `mcp`
  (`cargo build --features mcp --bin huginndb-mcp`), así que un
  `pnpm tauri:build` normal no se ve afectado. Consulta [`docs/MCP.md`](docs/MCP.md).
  
### Corregido

- **Las conexiones multi-base ahora muestran un nombre en la barra de título
  (#51).** La miga de pan central pintaba el catálogo de la conexión
  directamente, así que una conexión multi-base (sin una base preseleccionada)
  dejaba el segmento central vacío. Ahora recurre al nombre de la conexión
  cuando no hay una única base.
- **El editor lateral acoplado ya no conserva el valor de otra tabla (#49).**
  Abrir una celda en el editor lateral y cambiar a otra pestaña dejaba el valor
  antiguo en pantalla aunque estuvieras viendo una tabla distinta. El panel
  queda ahora ligado a la pestaña que abrió la celda: se limpia al cambiar de
  pestaña (salvo que el búfer tenga cambios sin guardar, que se conservan para
  que un cambio de pestaña nunca pierda tu trabajo).
- **La guía de redimensionado de columnas cae sobre el borde real (#46).** La
  guía en vivo se posicionaba con los anchos nominales de TanStack, pero la
  rejilla usa un diseño `table-fixed` a ancho completo que estira las columnas
  más allá de esos anchos cuando no llenan la vista, así que la guía se
  desplazaba a la izquierda del borde real (el error crecía por columna). Ahora
  mide la posición renderizada de la cabecera que se redimensiona.
- **Las conexiones MongoDB abren sin base preseleccionada (#52).** Abrir una
  conexión MongoDB en modo multi-base fallaba con un error del driver porque
  listar colecciones requería una base seleccionada, lo que dejaba en blanco
  todo el árbol. Listar colecciones a nivel de clúster ahora devuelve vacío
  (como ya hacen los drivers SQL), así que la lista de bases se renderiza y
  puedes expandir una base concreta como antes.
- **Las ventanas nuevas son independientes de la principal (#50).** «Nueva
  ventana» abría una ventana que adoptaba la conexión activa de la principal —
  aparecía conectada sin que el usuario abriera nada, contradiciendo la
  independencia por ventana introducida en 1.4.0. El conjunto de conexiones
  abiertas es ahora por ventana: una ventana muestra una conexión como activa
  solo cuando abre el pool ella misma. La configuración compartida (perfiles
  guardados y preferencias) sigue sincronizándose entre ventanas, y una
  conexión cerrada en una ventana se sigue limpiando en las demás que la
  tuvieran abierta.

### Cambiado

- **El instalador de Windows pasa de MSI (WiX v3) a NSIS.** El build de release
  empezó a fallar al empaquetar el `.msi` en los runners Windows de GitHub —
  WiX v3 está archivado y sin mantenimiento desde febrero de 2025, y su
  `light.exe` fallaba de forma sistemática incluso al arrancar en la flota de
  runners actual, sin importar la imagen del SO (Windows Server 2022 o 2025),
  con un fallo pelado sin más detalle. Tauri soporta oficialmente MSI → NSIS
  como ruta de actualización (no al revés), y el `tauri-cli` que ya usa el
  proyecto (2.11.1) incluye la detección de una instalación MSI previa por
  parte de NSIS. Las instalaciones existentes reciben un `-setup.exe` en vez
  de un `.msi`; la app instalada no cambia.
- **`huginndb-mcp` se traslada a su propio crate del workspace
  (`src-tauri/mcp-server/`).** El cambio a NSIS anterior destapó un segundo
  problema, distinto, del bundler: con más de un `[[bin]]` en un paquete,
  `tauri-bundler` intenta medir/empaquetar todos los binarios declarados sin
  importar el feature-gating, así que buscaba un artefacto de `huginndb-mcp`
  que un `pnpm tauri:build` normal nunca produce. Mover el shim (ya era muy
  fino) a un crate hermano lo saca por completo del `cargo metadata` de la
  app. Se compila con `cargo build -p huginndb-mcp --release` desde
  `src-tauri/` — ver [`docs/MCP.md`](docs/MCP.md).

## [1.6.1] — 2026-07-10

### Añadido

- **Gestor de conexiones con búsqueda, árbol y multiselección (#39, #43, #40).**
  El rail izquierdo del gestor era una lista plana de selección única que se
  volvía difícil de escanear y buscar en cuanto tenías más de unas pocas
  conexiones. Ahora:
  - incluye un **buscador** que filtra por nombre, host, base de datos, grupo o
    URI;
  - muestra las conexiones como un **árbol de carpetas** (agrupadas por el campo
    `group`) con cabeceras de grupo colapsables — una búsqueda activa las
    despliega para que las coincidencias siempre se vean;
  - permite **multiselección** (Ctrl/Cmd+clic para alternar, Mayús+clic para un
    rango, más checkboxes por fila al pasar el ratón) con un **borrado masivo**
    que siempre pide confirmación, independientemente de la preferencia
    "confirmar acciones destructivas".
- **Duplicar conexión (#38).** El gestor de conexiones incorpora una acción
  *Duplicar* que clona el perfil seleccionado en un borrador nuevo con el nombre
  uniquificado ("… (copia)"), listo para ajustar y guardar. La contraseña no se
  copia a propósito — las credenciales se indexan por id de perfil en el
  keychain del SO y el clon recibe un id nuevo — así que un aviso recuerda
  reintroducirla antes de conectar.
- **Modo de despliegue de grupos configurable (#40).** Una nueva preferencia en
  General (`Grupos de conexiones`) controla cómo aparecen los grupos de carpetas
  en el menú Archivo y en el gestor de conexiones — *siempre desplegados*,
  *siempre plegados* o *recordar por grupo* (el comportamiento anterior). Los
  grupos del menú Archivo ahora también son colapsables, igual que el switcher
  de la barra de estado.
- **Logos de marca en el desplegable de driver.** El selector de driver del
  editor de conexiones ahora muestra el logo oficial de cada base de datos junto
  a su nombre (tanto en el control como en las opciones), reutilizando los
  `DriverBadge` ya empaquetados y usados en el resto de la app, en lugar de una
  lista de nombres a secas.
- **Guía en vivo al redimensionar columnas de la tabla (#42).** Arrastrar el
  borde de una columna ahora muestra una guía vertical de altura completa que
  sigue al cursor, para ver el ancho objetivo antes de soltar en vez de tener
  que orientarte con la columna vecina. El ancho se sigue aplicando al soltar
  (el comportamiento diferido y persistido por tabla de siempre).

### Corregido

- **El editor lateral acoplado ahora se cierra cuando se cierra su pestaña de
  origen.** El editor lateral (estilo JetBrains) vive fuera del subárbol de
  cualquier pestaña, así que abrir una celda en él y luego cerrar la pestaña de
  esa tabla lo dejaba colgado con un valor obsoleto, esperando un descarte
  manual. Ahora la celda registra la pestaña que la abrió y el panel se cierra
  solo cuando esa pestaña (o su conexión) desaparece.
- **El deshacer del editor de celdas ya no alcanza la celda editada
  anteriormente.** El editor lateral acoplado (y el modal) reutilizaban un único
  modelo de Monaco entre celdas, así que tras editar un registro, seleccionar la
  misma columna en otro registro y pulsar Ctrl+Z restauraba el valor del
  registro *anterior*. Ahora Monaco se remonta con una pila de deshacer vacía en
  cada carga de celda, de modo que el deshacer queda acotado a la sesión de
  edición actual; escribir dentro de una celda se sigue deshaciendo con
  normalidad.
- **El selector booleano de celdas BIT ya no se cierra al abrirlo (#44).** Al
  editar una columna BIT de un registro existente (con BIT mostrado como
  booleano) se abría el `<select>` nativo pero se cerraba en cuanto pulsabas una
  opción: el `onClick` de la celda devolvía el foco al contenedor con scroll,
  robándoselo al desplegable. Ahora la celda cede los clics a su propio editor
  inline mientras está activo.
- **Abrir una tabla ya no lanza COUNT + SELECT dos veces (#41).** Dos cosas
  duplicaban la carga inicial: el callback dependía de `searchColumns` (derivado
  de la lista de columnas que se carga de forma asíncrona, así que cambiaba de
  identidad y reejecutaba el efecto al llegar las columnas) y React StrictMode
  invoca los efectos dos veces en desarrollo. Ahora `searchColumns` se lee
  mediante una ref y la carga se deduplica en el envío — una petición idéntica
  ya en vuelo se descarta — así que abrir una tabla lanza exactamente un
  COUNT + SELECT, tanto en desarrollo como en producción.

## [1.5.1] — 2026-07-07

### Añadido

- **Eliminar base de datos desde el explorador multi-base (#19).** El menú
  contextual del nodo de base de datos incorpora una acción destructiva
  "Eliminar base de datos…" (solo Postgres/MySQL), para poder borrar una base
  que hayas creado — antes el nodo solo ofrecía "Nueva query aquí" / "Seguridad"
  y una base recién creada quedaba atascada. Un nuevo comando de backend
  `drop_database` (validado con `validate_ident`) cierra el pool sintético por
  base de datos (esperando a `Pool::close`) antes de lanzar `DROP DATABASE`,
  para que Postgres no lo rechace por tener sesiones activas; al terminar, la UI
  cierra las pestañas y el esquema de esa base y refresca el árbol.
- **Agrupaciones de conexión como carpetas en el menú File (#20).** El menú File
  listaba todas las conexiones en plano, así que el `group` de un perfil no
  tenía efecto visible ahí. Ahora se agrupan: primero las sin grupo, luego una
  carpeta etiquetada por grupo (ordenadas) con sus conexiones indentadas debajo.
- **Combobox temático para el campo Grupo (#21).** El campo Grupo del editor de
  conexiones usaba un `<datalist>` nativo cuyo desplegable lo dibujaba el
  SO/webview e ignoraba el tema de la app. Ahora es un combobox temático (y sigue
  permitiendo crear: escribir un nombre nuevo crea un grupo nuevo) que filtra por
  subcadena los grupos existentes en un popover con el estilo de la app.
- **Colorear pestañas (#24).** Las pestañas abiertas se pueden colorear desde su
  menú ⋮ (seis colores predefinidos + limpiar); el color se muestra como una
  franja de 2px en el borde superior de la pestaña y se persiste por conexión.
- **Botón de refresco en el editor de estructura (#25).** La pestaña de
  estructura incorpora un botón para releer la definición actual de la tabla
  desde el servidor, y así traer cambios hechos en otro sitio con la pestaña
  abierta.
- **Ir arriba / ir abajo en la consola (#29).** Dos botones en la barra saltan
  al primer o último registro del log.
- **Conexión activa marcada en el desplegable de estado (#31).** La conexión en
  la que está enfocado el workspace ahora recibe un wash de marca + etiqueta
  "activa" en el desplegable de la barra de estado, distinta de las demás filas
  solo conectadas.

### Corregido

- **Los errores de conexión ya no se cortan en el borde del diálogo.** Un Test /
  Conectar fallido mostraba su mensaje de backend (a menudo largo) en una única
  línea con `truncate` en el pie del diálogo de conexiones, así que todo lo que
  excedía el ancho quedaba cortado con puntos suspensivos e ilegible — la
  mayoría de errores de driver son mucho más anchos que el pie. Los estados de
  error ahora usan una caja acotada, con salto de línea y scroll vertical
  (tintada en color destructivo, con icono de alerta) y un botón para copiar el
  mensaje completo; los estados cortos (probando / correcto / guardado) siguen
  en una sola línea.
- **La misma tabla en dos conexiones/bases ya no se muestra con pestañas
  idénticas (#22).** Las etiquetas de pestaña solo añadían el prefijo de conexión
  cuando había más de una conexión con pestañas abiertas, y el prefijo omitía la
  base de datos, así que la misma tabla abierta en dos conexiones (o dos bases
  con el mismo nombre) aparecía como un nombre indistinguible. Ahora las
  etiquetas incluyen el contexto `conexión · base` y lo muestran en cuanto otra
  pestaña abierta comparte el nombre base.
- **Un segundo lanzamiento por CLI ya no abre una tercera ventana (#23).** Con
  "abrir siempre en una ventana nueva" activado, lanzar de nuevo desde la CLI con
  una instancia ya en marcha producía tres ventanas. El enrutado del segundo
  lanzamiento se ejecutaba en todas las ventanas, así que la ventana creada para
  satisfacer la ruta "nueva ventana" volvía a drenar el buffer de intención
  compartido y lo enrutaba una segunda vez. Ahora el enrutado está limitado solo
  a la ventana principal.
- **Las tablas vacías muestran sus columnas y el botón de insertar (#27).** Una
  tabla sin filas no mostraba cabeceras ni forma de añadir la primera fila,
  porque las columnas se derivaban de la primera fila. `fetch_table_data` ahora
  recurre a la definición del catálogo cuando una página vuelve vacía.
- **Los errores al aplicar DDL se muestran (#26).** Un cambio de estructura que
  la base de datos rechaza — p. ej. una clave primaria que excede el máximo de
  bytes de MySQL — solo aparecía en el pequeño panel de vista previa DDL y
  parecía no hacer nada. Ahora también lanza un toast.
- **El campo de puerto se puede vaciar (#28).** Vaciar un campo de puerto
  numérico dejaba un `0` pegado que no se podía borrar. Ahora el `0` se muestra
  como campo vacío, restaurando el borrado/reescritura normal (los cuatro
  campos de puerto).
- **Sin selección de texto al seleccionar filas con Shift+Click (#30).**
  Seleccionar un rango de filas también arrastraba una selección de texto; el
  grid ahora es `select-none`.
- **Consistencia de los desplegables de conexión (#31).** El desplegable del
  menú File ya muestra los grupos de conexión (ver el cambio de agrupación
  arriba) y el desplegable de la barra de estado marca la conexión activa,
  resolviendo ambas partes del reporte.

## [1.5.0] — 2026-07-04

### Añadido

- **Crear base de datos.** Tanto la barra de herramientas del explorador
  multi-BD como la cabecera raíz de una conexión de una sola base de datos
  ganan un botón "+" (solo Postgres/MySQL — es DDL de nivel de servidor,
  oculto para SQLite/MongoDB) que abre un diálogo de nombre y ejecuta
  `CREATE DATABASE` mediante un nuevo comando de backend `create_database`,
  validado con la misma lista de permitidos `validate_ident` que usa el
  editor de estructura. La barra multi-BD refresca su lista de bases de
  datos al crear una; una conexión de una sola base de datos no tiene esa
  lista que mostrar, así que confirma con un mensaje en su lugar (un perfil
  limitado a una base de datos es al menos tan común como la navegación
  multi-BD — no hay razón para que sea el único modo que no puede crear una
  base de datos hermana en el mismo servidor).
- **Columnas redimensionables en la rejilla de datos.** `DataGrid.tsx`
  incorpora ahora la API de redimensionado de columnas de TanStack Table
  (tiradores en los bordes de columna, `columnResizeMode: "onEnd"` para que
  arrastrar no dispare un re-render por cada frame). Los anchos se
  persisten por tabla navegada (nuevo `grid.columnWidths` en `prefs.json`,
  indexado por `"<esquema>.<tabla>"` y luego por nombre de columna) — las
  rejillas de resultados de consultas ad-hoc redimensionan solo durante la
  sesión, ya que no tienen una identidad de tabla estable a la que
  asociarlo.
- **Agrupación de conexiones.** `ConnectionProfile` gana un campo `group`
  de texto libre (un solo grupo por conexión, sin registro de grupos
  aparte — se agrupan por igualdad simple de texto), editable desde un
  nuevo campo "Grupo" en el diálogo de conexión (con sugerencias de grupos
  ya existentes para evitar duplicados por error). El desplegable de
  conexiones de la barra de estado (`StatusConnections.tsx`) — el selector
  real que usa la app — agrupa ahora tanto las conexiones activas como las
  disponibles en cabeceras colapsables por grupo, dejando las conexiones
  sin grupo igual que antes, sin cabecera. El estado de colapsado se guarda
  por nombre de grupo en `prefs.json` (`ui.collapsedConnectionGroups`).
  Nuevo helper `bucketByGroup` en `src/lib/utils.ts`.

### Corregido

- **Conectar el mismo perfil desde una segunda ventana tiraba el pool en
  vivo de la primera ventana.** `ActiveConnections::insert` reemplaza
  incondicionalmente cualquier pool ya registrado para un id — correcto
  para reconectar un pool muerto, incorrecto para una segunda ventana
  llamando a `connect` sobre un perfil ya activo, lo que tiraba en silencio
  el pool (y cualquier túnel SSH) de la primera ventana. `connect` ahora
  comprueba `ActiveConnections::contains` primero y no hace nada (reutiliza
  el pool existente) en vez de caer al camino de reemplazo.
- **Ninguna ventana se enteraba de las conexiones, ediciones de perfil o
  cambios de preferencias hechos en otra ventana.** Cada ventana de Tauri
  comparte el mismo `AppState` de backend, pero cada frontend guardaba una
  copia privada de `active`/`profiles`/`prefs` tomada solo al arrancar, sin
  ningún puente de vuelta — peor que simple desactualización en el caso de
  las preferencias, ya que cada guardado envía el blob *entero* (no un
  diff): dos ventanas cambiando ajustes distintos podían perder en silencio
  el que se guardara primero en cuanto se disparara el guardado con
  retardo de la otra. `connect`/`disconnect`/`save_profile`/
  `delete_profile`/`import_profiles`/`update_preferences` emiten ahora los
  eventos `connection-opened`/`-closed`/`profiles-changed`/`prefs-changed`;
  nuevos bridges de frontend (`connection-sync-bridge.ts`,
  `prefs-sync-bridge.ts`) los aplican en el store de cada ventana —
  `markConnected`/`markDisconnected` en `stores/connections.ts` (extraídos
  de `connect()`/`disconnect()` para que la ruta de sincronización y la
  ruta local compartan exactamente la misma limpieza, incluido el barrido
  de pestañas/esquema de las conexiones hijas sintéticas multi-BD) y
  `applyExternal` en `stores/preferences.ts` (adopta el snapshot recibido
  sin volver a disparar un guardado, así que no puede entrar en bucle ni
  volver a competir).
- **`insert_row`/`update_cell` de MySQL podían enlazar una columna `BIT`
  como texto plano cuando la metadata de caché de esquema del frontend aún
  no había cargado.** Ambos comandos decidían si envolver el placeholder de
  una columna `BIT` de MySQL en `CAST(? AS UNSIGNED)` según una pista
  `column_type` que envía el frontend junto al valor; cuando esa pista es
  `None` (caché de esquema vacía/desactualizada para la tabla en
  cuestión), el valor se enlazaba como una cadena de texto plano, que MySQL
  rechaza con `1406 (22001): Data too long for column` para cualquier cosa
  más ancha de un carácter (p. ej. `"true"`). Ambos comandos ahora recurren
  a una consulta de catálogo (`list_columns_inner`, el mismo helper que ya
  usa `fetch_fk_options`) cuando falta la pista, así que una columna `BIT`
  se detecta correctamente de cualquier forma. `insert_row` solo paga el
  viaje de ida y vuelta extra cuando al menos un valor realmente carece de
  pista de tipo.
- **Las entradas de log de la Consola y del ciclo de vida de la conexión se
  filtraban entre ventanas.** Cada ventana de Tauri (la principal, o
  cualquier "Ventana nueva" secundaria) montaba el mismo frontend y se
  suscribía de forma independiente al mismo evento de log del backend, que
  se emitía como broadcast a todo el proceso (`AppHandle::emit`) en vez de
  dirigido — así que una consulta ejecutada en una ventana aparecía también
  en la Consola de todas las demás ventanas abiertas, haciendo que una
  ventana secundaria pareciera una copia sin sentido de la principal en vez
  de una instancia independiente. `log_bus::emit` recibe ahora la etiqueta
  de la ventana de origen y entrega solo a esa ventana
  (`AppHandle::emit_to`); todos los comandos que producen una entrada de
  log SQL o de ciclo de vida de conexión (`execute_query`, `execute_batch`,
  `fetch_table_data`, `update_cell`, `delete_rows`, `insert_row`, `connect`,
  `disconnect`, `test_connection`, `open_database_view`) reciben ahora un
  parámetro `tauri::Window` (inyectado automáticamente por Tauri desde el
  webview invocante — sin cambios en el frontend) para suministrarla. La
  entrada de diagnóstico propia del keepalive en segundo plano no tiene una
  ventana de origen única (informa sobre una conexión que cualquier
  ventana puede estar navegando), así que sigue siendo broadcast vía una
  nueva `log_bus::broadcast`; el evento separado `connection-lost` que
  emite para la UX de reconexión ya era correcto como broadcast y no se ha
  tocado.

## [1.4.0] — 2026-07-02

### Añadido

- **Usuarios/permisos del servidor (panel "Seguridad").** Un nuevo botón
  "Security" junto al de refrescar del explorador de esquema (y, por base de
  datos, en el menú contextual del explorador multi-BD) abre una pestaña con
  los usuarios/roles que la conexión puede ver, con los privilegios
  cargándose bajo demanda al expandir cada fila. Implementado para **todos**
  los drivers, no solo un subconjunto: **PostgreSQL** (`pg_roles` +
  `pg_auth_members` para la pertenencia a roles, permisos sobre tablas vía
  `information_schema.role_table_grants`), **MySQL** (`mysql.user` +
  `mysql.role_edges` para los roles de MySQL 8, privilegios parseados desde
  `SHOW GRANTS FOR '<user>'@'<host>'` porque MySQL no tiene una vista de
  catálogo equivalente a la de Postgres), **MongoDB** (`usersInfo` sobre la
  base de datos resuelta, privilegios vía `usersInfo` con
  `showPrivileges: true`), y **SQLite**, que no tiene ningún concepto de
  usuarios/permisos y ahora muestra un estado vacío explícito ("este driver
  no tiene modelo de usuarios en el servidor") en vez de omitir la función en
  silencio. Una cuenta de MySQL sin `SELECT` sobre `mysql.user` degrada a
  mostrarse solo a sí misma (`CURRENT_USER()`) en vez de fallar todo el
  panel. Nuevos comandos de backend `list_users` / `list_privileges` en
  `src-tauri/src/commands/schema.rs` (despachados a
  `src-tauri/src/db/mongo/schema.rs` para MongoDB); nuevos DTOs `UserInfo` /
  `PrivilegeInfo` reflejados en `src/types.ts`; nuevo componente frontend
  `SecurityTab.tsx` (TanStack Table) y tipo de pestaña `security`.
- **Keepalive de conexión + reconexión tras pérdida de conexión.** HuginnDB
  no hacía nada proactivo para mantener una conexión viva — sin timeout de
  inactividad, sin heartbeat — dependiendo por completo del comportamiento
  por defecto de `sqlx` ("validar en el siguiente uso"), que no ayuda con un
  pool inactivo entre acciones del usuario ni con un túnel SSH caído. Cada
  conexión de nivel superior recibe ahora un ping en segundo plano cada 3
  minutos; un ping fallido marca la conexión como perdida, lo que pone en
  rojo su punto de estado tanto en la lista de conexiones como en el
  desplegable de conexiones de la barra de estado, y sustituye el botón de
  conectar/desconectar por uno de "reconectar" de un solo clic — se acabó
  descubrir una conexión muerta a mitad de una consulta con solo un error
  críptico del driver. Reconectar reutiliza el mismo id de conexión y
  mantiene intactas las pestañas abiertas y el estado del árbol de esquema,
  en vez de cerrarlo todo y empezar de cero. Limitado a las conexiones de
  perfil de nivel superior; los pools sintéticos por base de datos del modo
  multi-BD comparten la viveza de su conexión padre y no reciben un
  heartbeat propio. Nuevo módulo de backend `src-tauri/src/keepalive.rs`;
  nuevo frontend `stores/connectionHealth.ts` +
  `lib/connection-health-bridge.ts`.
- **F5 / Ctrl+R (Cmd+R en macOS) ahora refrescan dentro de la app en vez de
  recargar el WebView como si fuera una pestaña de navegador.** Con una
  pestaña de tabla activa, vuelve a ejecutar la consulta de esa pestaña
  (igual que pulsar su botón de recargar, respetando los filtros/orden/
  página actuales); si no, refresca el árbol de esquema (lista de bases de
  datos y tablas) de la conexión seleccionada — el mismo objetivo que el
  botón de refrescar del explorador, tanto en modo single-BD como multi-BD.
  Nuevo registro `src/lib/tableRefresh.ts` (con la misma forma "se registra
  al montar, se limpia al desmontar" que el registro de proveedores SQL de
  Monaco) que permite al manejador de teclas global en `App.tsx` llegar a la
  función de recarga de la pestaña de tabla activa sin pasar un callback a
  través del árbol de paneles de dockview.

### Cambiado

- **Los workspaces se sustituyen por ventanas nativas.** Los workspaces
  nunca fueron más que un sustituto de las instancias reales por ventana, y
  el diálogo "nuevo workspace vs actual" que aparecía al lanzar
  `huginndb …` por segunda vez nunca funcionó del todo bien. El selector de
  workspaces desaparece; **Ventana → Ventana nueva** abre ahora una ventana
  de sistema real y en blanco. Las ventanas secundarias son intencionalmente
  **efímeras** — nada de sus pestañas o su disposición sobrevive a un
  reinicio de la app, solo lo de la ventana principal. El fichero
  `tab_state.json` pasa a v3 (un mapa plano de `connections`); al
  actualizar, un blob v2 conserva solo las pestañas del workspace que
  estaba **activo** y descarta el resto — no hay fusión. El diálogo de
  segundo lanzamiento sigue preguntando "¿esta ventana o una nueva?" por
  defecto, pero ahora incluye un interruptor "No volver a preguntar" que
  recuerda la elección (`Preferencias → cliConnectDefault`).
- **Los menús de la barra superior pasan de 2 a 4.** Archivo y Vista habían
  acumulado acciones sin relación entre sí a medida que crecía la app.
  Archivo ahora solo gestiona conexiones (nueva/gestionar/importar/exportar,
  la lista de conexiones, desconectar todas); un nuevo menú **Ventana**
  incluye Ventana nueva y Restablecer disposición de ventanas; un nuevo
  menú **Ayuda** incluye Reportar/sugerir y Acerca de (antes solo en
  Archivo y solo accesible desde el icono de engranaje, respectivamente).
  Vista no cambia (visibilidad de paneles + métrica del árbol de esquema).

### Corregido

- **Una ventana nueva creada desde "Ventana → Ventana nueva" aparecía en
  blanco y Windows la marcaba como "No responde".**
  `WebviewWindowBuilder::build()` se bloquea en Windows cuando se llama
  desde un comando de Tauri síncrono — un problema documentado de
  WebView2. `open_new_window` es ahora una `async fn`, que es la solución
  que indica la propia documentación de Tauri.
- **Una conexión ad-hoc por CLI (`--host …`) sin `--password` nunca llegaba
  a conectar realmente**, incluso al elegir "esta ventana" en el diálogo de
  segundo lanzamiento — creaba en silencio un perfil desconectado y solo
  dejaba una pista en la Consola. Ahora siempre se intenta conectar (SQLite
  no tiene concepto de contraseña, y algunos servidores permiten
  autenticación sin contraseña/de confianza); un fallo de autenticación
  real sigue mostrándose igual que en una conexión de perfil guardado.

## [1.2.0] — 2026-06-18

### Añadido

- **Consolidación en una sola ventana (instancia única).** Lanzar `huginndb` de
  nuevo con una ventana ya abierta ya no crea una segunda ventana. Se enfoca la
  ventana existente y —si el nuevo lanzamiento trae una conexión
  (`--connect-profile`, `--host …`, `--uri …`)— un diálogo pregunta si abrirla
  en un **workspace nuevo** o en el **actual**. Esto convierte el workspace en
  el verdadero contenedor de nivel superior: mantén, por ejemplo, una conexión
  MySQL de «configuración» y una MongoDB de «datos» a la vez en una sola ventana
  en lugar de dos instancias separadas tipo IDE. Un relanzamiento sin flags de
  conexión simplemente trae la ventana al frente. Implementado con
  `tauri-plugin-single-instance`; el argv del segundo lanzamiento se parsea con
  el mismo código que el arranque en frío y se reenvía por un nuevo evento
  `huginndb://cli-connect` (con búfer en el backend para sobrevivir a un
  lanzamiento que coincida con el arranque de la ventana).
- **Reporte de incidencias integrado.** Una nueva entrada *Reportar / sugerir*
  (menú Archivo, y una acción «Reportar este error» en las entradas con error de
  la Consola) abre un diálogo para crear un **bug** o una **sugerencia de
  feature** directamente en el tracker de GitHub. Con un Personal Access Token
  de GitHub configurado (guardado en el llavero del SO, nunca en disco) la
  incidencia se crea directamente vía la API REST y se enlaza de vuelta; sin él,
  se abre en el navegador una página `issues/new` pre-rellenada para enviarla a
  mano. Los reportes pueden incluir diagnósticos opcionales (versión de la app,
  SO/arquitectura), y la ruta «Reportar este error» pre-rellena el driver, la
  sentencia y el texto del error. Añade una dependencia `reqwest` (rustls) para
  la ruta de la API.
- **Ordenación multicolumna en la rejilla de datos.** Un clic normal en la
  cabecera de una columna ordena por ella (ciclo ASC → DESC → sin orden);
  **Ctrl/Cmd+clic** añade la columna como nivel de orden adicional de menor
  precedencia (ciclo ASC → DESC → eliminado en su sitio). Las cabeceras muestran
  ahora una flecha de dirección (↑/↓) en vez de solo resaltarse, más un pequeño
  número de nivel cuando participa más de una columna, de modo que la ordenación
  activa se lee de un vistazo en lugar de deducirse solo desde la consola. El
  comando `fetch_table_data` recibe ahora una lista ordenada `order` (en
  sustitución del par único `orderBy`/`orderDesc`) y construye
  `ORDER BY c1 …, c2 …` en los cuatro drivers (la ruta de MongoDB usa un
  documento de orden multiclave).
- **Iconos de clave primaria/ajena en las columnas de datos.** Las cabeceras de
  la rejilla muestran ahora un icono de llave —ámbar para una columna de clave
  primaria, azul cielo para una clave ajena de una sola columna— y el explorador
  de esquema gana la llave de clave ajena junto a la de clave primaria que ya
  existía. Replica los indicadores de clave a simple vista de HeidiSQL; usa
  metadata que `list_columns` ya devuelve, sin consultas extra.

### Rendimiento

- **Evitar el `COUNT(*)` redundante al ordenar o paginar.** El navegador de
  datos volvía a ejecutar `SELECT COUNT(*)` en cada fetch, incluso en cambios de
  solo orden/offset/página donde el total no puede haber cambiado. El frontend
  cachea ahora el total y solo lo recalcula cuando cambia el predicado de
  filtro/búsqueda (nuevo flag `with_count` en `fetch_table_data`), eliminando un
  viaje de ida y vuelta por cada interacción de orden/página —más notable en
  tablas grandes. La ruta de exploración de MongoDB omite `count_documents` de
  la misma forma. (Ordenar por una columna sin índice sigue siendo un orden
  completo del lado del servidor; eso depende de los índices de la tabla, no del
  cliente.)

### Cambiado

- **Confirmación de «Eliminar tabla» más simple.** Eliminar una tabla ya no
  exige escribir el nombre de la tabla para confirmar: ahora muestra un diálogo
  de confirmación destructiva normal (con un aviso de irreversibilidad) y una
  elección Cancelar / Eliminar, como esperan los usuarios de otros gestores de
  bases de datos. La acción sigue protegida tras una confirmación explícita;
  solo se quitó la fricción de teclear el nombre.

## [1.1.1] — 2026-06-15

### Añadido

- **Formulario de conexión de MongoDB (basado en campos).** El diálogo de
  conexión de MongoDB es ahora primordialmente un formulario, como Mongo
  Compass: campos discretos (host, puerto, base de datos, usuario, contraseña,
  **auth source**) construyen la cadena de conexión `mongodb://` en vivo,
  mostrada en modo solo lectura debajo. Un nuevo conmutador **Editar cadena de
  conexión** revela la URI cruda para editarla a mano —con un aviso ámbar de que
  las ediciones manuales pueden introducir errores— para los casos que el
  formulario no cubre (Atlas `mongodb+srv://`, conjuntos de réplica, opciones
  extra de URI). La contraseña nunca se incrusta en la cadena almacenada: sigue
  pasando por el llavero del SO. Editar un perfil guardado vuelve a poblar el
  formulario cuando su URI es representable, y se abre en modo de edición cruda
  en caso contrario.
- **`authSource` para MongoDB.** Un campo dedicado *Auth source* (p.ej. `admin`)
  se añade a la cadena de conexión como `?authSource=…`, y un nuevo flag de CLI
  `--auth-source` cubre la ruta ad-hoc sin URI
  (`--host … --auth-source admin`). Antes la única forma de configurarlo era
  escribir la URI entera a mano, y la ruta de campos discretos lo omitía por
  completo — así que los inicios de sesión de MongoDB sin URI que necesitaban una
  base de datos de autenticación no predeterminada fallaban.
- **Filtro multi-tabla en el explorador de esquemas (estilo HeidiSQL).** El
  filtro de tablas acepta ahora varios patrones separados por `;` y coincide con
  una tabla cuando contiene **cualquiera** de ellos, así que `users; orders`
  muestra ambas a la vez. Funciona en exploradores tanto de una sola base de
  datos como multi-base-de-datos.

### Corregido

- **El panel de detalle de la Consola se puede cerrar sin vaciar la consola.**
  Hacer clic en una entrada de log abría su vista de detalle sin forma de volver
  a la lista completa salvo vaciar la consola; un botón de **cerrar** (y la tecla
  `Esc`) descartan ahora el detalle y devuelven a la lista de entradas.

## [1.1.0]

### Añadido

- **Driver de MongoDB (MVP).** HuginnDB se conecta ahora a MongoDB junto a los
  motores SQL. Conecta con una cadena de conexión (`mongodb://…` o Atlas
  `mongodb+srv://…`, la entrada principal — cubre conjuntos de réplica,
  `authSource` y opciones de URI), navega por bases de datos → colecciones en el
  explorador, e inspecciona documentos en la rejilla de datos (los campos de
  nivel superior se convierten en columnas, `_id` primero; los documentos/arrays
  anidados se renderizan como JSON y se expanden en la previsualización de celda).
  - **Editor de consultas estilo `mongosh`.** Ejecuta `db.coll.find({…})`,
    `.aggregate([…])`, `.countDocuments(…)`, `.distinct(…)` y los métodos de
    escritura (`insertOne`/`insertMany`, `updateOne`/`updateMany`, `replaceOne`,
    `deleteOne`/`deleteMany`), con `.sort()/.limit()/.skip()/.projection()`
    encadenados en `find`. Se admiten JSON relajado (claves sin comillas, comillas
    simples) y los constructores BSON comunes (`ObjectId(...)`, `ISODate(...)`,
    `NumberLong/Int/Decimal(...)`).
  - **Edición por `_id`.** Las ediciones de celda en línea, las inserciones de
    fila y los borrados se mapean a `updateOne`/`insertOne`/`deleteMany`
    indexados por `_id`. El tipo BSON inferido del campo guía la coerción de
    valor, de modo que un campo `Date`/`Long`/`Int` no se degrada silenciosamente
    a cadena.
  - **Estructura de solo lectura.** La vista de estructura muestra los campos
    inferidos de una colección y sus índices reales; se admite eliminar la
    colección desde el explorador. La edición de índices/validadores, las
    transacciones y la transferencia de perfiles para MongoDB quedan diferidas —
    véase `docs/MONGODB_ROADMAP.md`.
  - **Túnel SSH** disponible para conexiones `mongodb://` de un solo host; está
    deshabilitado para `mongodb+srv://` (un registro SRV resuelve a varios hosts,
    que el túnel de un solo puerto no puede representar).
  - **CLI:** `--driver mongodb` funciona con los flags discretos
    `--host`/`--port`, y un nuevo flag `--uri` / `--connection-string` acepta una
    URI `mongodb://` o `mongodb+srv://` completa (la única forma de alcanzar
    Atlas desde la CLI). Una cadena de conexión implica el driver de MongoDB
    cuando se omite `--driver`, y MongoDB se ofrece ahora en el selector de driver
    ad-hoc.

 - **Cerrar pestañas en bloque desde el menú de pestañas.** Hacer clic derecho en
  una pestaña del espacio de trabajo (o el menú `⋮` de la pestaña) ofrece ahora
  **Cerrar otras pestañas** y **Cerrar todas las pestañas** además de **Cerrar
  pestaña**, de modo que un espacio de trabajo lleno de tablas/consultas abiertas
  se puede limpiar en una sola acción en vez de cerrar cada pestaña
  individualmente.

### Corregido

- **Filtrar el explorador de esquemas ya no falla en conexiones sin estadísticas
  de tabla.** `list_tables` serializaba las estadísticas ausentes de recuento de
  filas / tamaño como JSON `null`; el badge de métrica del explorador solo se
  protegía contra `undefined`, así que un `null` llegaba a `formatBytes` y lanzaba
  *"Cannot read properties of null (reading 'toFixed')"* — tumbando todo el
  panel. Esto afectaba a las conexiones CLI/ad-hoc y a builds de SQLite sin
  `dbstat`, y aparecía al filtrar porque el filtro fuerza la expansión de todas
  las secciones (renderizando badges que antes estaban colapsados). El backend
  omite ahora las estadísticas ausentes (acorde al contrato `?: number` del
  frontend) y el badge se protege con `!= null`; `formatBytes`/`formatCount`
  además abortan ante entradas no finitas.
- **Abrir o cerrar el editor de celda lateral ya no reinicia la división Esquema /
  Espacio de trabajo.** El editor lateral se acopla como hermano en la fila
  `[Esquema | Espacio de trabajo | Celda]`, y dockview redistribuye el espacio
  liberado/ocupado proporcionalmente entre *todos* los hermanos cuando se añade o
  elimina un hijo — redimensionando silenciosamente el panel de Esquema cada vez.
  El ancho de Esquema se recuerda ahora mientras el editor lateral está ausente y
  se vuelve a imponer en cada apertura/cierre, de modo que solo el panel de
  Espacio de trabajo absorbe el cambio.
- **Duplicar una fila de MySQL con una columna `BIT` y luego guardar podía fallar
  con "Data too long for column".** El control 0/1 mostraba el valor normalizado
  pero dejaba la celda borrador con el valor crudo duplicado; si ese valor no era
  ya exactamente `"0"`/`"1"` (p.ej. un `"true"` duplicado, o una celda `BIT(1)`
  heredada que arrastraba un entero más ancho/basura), el valor crudo era lo que
  se confirmaba, y `CAST(? AS UNSIGNED)` a `BIT(1)` desbordaba. El control
  sincroniza ahora la celda confirmada con el `0`/`1` mostrado al montarse.

## [1.0.10] — 2026-06-11

### Añadido

- **Ejecutar un buffer entero de sentencias de una vez.** Pulsar `Ctrl+Enter` (o
  el nuevo botón "Run all (N)") en un editor que contiene varias sentencias
  delimitadas por `;` —p.ej. un lote de INSERTs copiado de la rejilla— las
  ejecuta ahora en orden sobre una única conexión y muestra un resumen por
  sentencia, con las filas del último SELECT en la rejilla. Antes el buffer
  entero se enviaba como una sola sentencia preparada, que el driver rechazaba
  ("cannot insert multiple commands into a prepared statement"). Ejecutarlas
  sobre una sola conexión también significa que un `BEGIN`/`COMMIT` explícito (o
  `USE` de MySQL) se arrastra ahora a través del lote. El CodeLens "▶ Run" por
  sentencia sigue ejecutando una sola sentencia.
- **Selector de base de datos en el editor de consultas.** En un servidor
  multi-base-de-datos (Postgres / MySQL) la pestaña de consulta tiene ahora un
  desplegable de base de datos: elige una base de datos y la consulta se ejecuta
  contra ella — y el autocompletado cambia a sus tablas — sin escribir `USE`/un
  prefijo de esquema en el SQL. Respaldado por los pools hijos por base de datos
  ya existentes. SQLite (archivo único) no muestra selector.
- **Previsualizaciones de tema y editor en Preferencias.** Apariencia muestra una
  pequeña maqueta del armazón de la app más muestras de color pintadas con el
  tema seleccionado; Editor muestra un fragmento SQL de ejemplo renderizado con
  la fuente, el tamaño, el ajuste de línea y los colores del tema de Monaco
  elegidos.
- **Conmutador de pantalla completa en el editor de celda lateral**, igual que el
  editor modal (`F11` / `Esc`, o el botón de cabecera).
- **Control dedicado 0/1 para columnas `BIT`** en la fila borrador de inserción y
  la edición de celda en línea (MySQL). Emite el valor numérico que la columna
  espera y etiqueta las opciones según la preferencia de visualización de BIT de
  la rejilla, en vez de un campo de texto que parecía pedir un booleano.

### Cambiado

- **Las conexiones abiertas desde la CLI son ahora temporales.** Una conexión
  ad-hoc lanzada con `--host …` se mantiene en memoria durante la sesión (de modo
  que el explorador y las pestañas funcionan con normalidad, marcada como "temp")
  pero ya no se escribe en `profiles.json`, así que no se acumula entre lanzamientos.
  Los perfiles creados en la app siguen persistiendo como antes.
- **Las tarjetas de badge de driver son conscientes del tema** — los logos de
  marca conservan sus colores pero la tarjeta/anillo siguen ahora el tema activo
  en vez de un cuadrado blanco fijo que chocaba con los temas oscuros.

### Corregido

- **Un `LONGTEXT` grande (p.ej. un documento JSON grande) en MySQL se renderizaba
  como un volcado hexadecimal.** Cuando el servidor marca una columna de texto
  como binaria (dependiente de charset/collation), sqlx la reporta como
  `LONGBLOB` y `try_get::<String>` la rechazaba en una comprobación de
  compatibilidad de tipo *antes* de mirar los bytes, así que el valor caía a hex
  sin importar su contenido. Ahora leemos los bytes crudos y validamos el UTF-8
  nosotros mismos, de modo que el texto UTF-8 válido se decodifica como texto.

## [1.0.9] — 2026-06-09

### Corregido

- **Abrir una base de datos concreta fallaba con "no stored password for keychain
  account" cuando la contraseña venía de la CLI.** Expandir una base de datos en
  el árbol levanta un pool hijo (`open_database_view`) que re-resolvía las
  credenciales desde el llavero del SO — pero una contraseña pasada vía
  `--password` (o el diálogo de conexión) vive solo en memoria y nunca se
  almacenaba allí. El backend mantiene ahora una caché en memoria, solo de sesión,
  del secreto usado al conectar (indexada por perfil, vaciada al desconectar);
  los pools hijos la reutilizan y solo recurren al llavero cuando no se cacheó
  nada.

## [1.0.8] — 2026-06-09

### Añadido

- **Driver de base de datos por defecto configurable** (Ajustes → General). Se usa
  cuando se crea una conexión sin un driver explícito: un lanzamiento por CLI sin
  `--driver`, y el driver inicial del formulario "Nueva conexión". Por defecto es
  **"Preguntar cada vez"** — así que un lanzamiento ad-hoc por CLI (`--host …`)
  sin `--driver` y sin un valor por defecto configurado abre ahora un selector de
  driver (y te anima a fijar uno por defecto) en vez de asumir silenciosamente
  PostgreSQL y desencajar con un servidor MySQL.

### Cambiado

- **`--driver` acepta ahora alias y es insensible a mayúsculas** (`MySQL`,
  `MYSQL`, `mariadb` → mysql; `postgresql`, `pg`, `psql` → postgres; `sqlite3` →
  sqlite). Un valor no reconocido ya no cae silenciosamente a PostgreSQL — enruta
  al selector de driver.
- **Los fallos de conexión causados por un driver desencajado se explican ahora a
  sí mismos.** Cuando un error de protocolo de cable indica el backend equivocado
  (p.ej. el driver de Postgres leyendo un handshake de MySQL — "Postgres protocol
  error … unknown transaction status"), el mensaje de error sugiere ahora cambiar
  de driver, en la Consola y en los diálogos de conexión.

## [1.0.7] — 2026-06-08

### Corregido

- **Las conexiones con SSL desactivado fallaban durante la negociación TLS**
  ("unexpected response from SSLRequest"). Con la casilla de SSL desmarcada la URL
  de conexión no llevaba `sslmode`, así que sqlx recurría a su valor por defecto
  `prefer`/`PREFERRED` — que aún envía un `SSLRequest` de Postgres (o negocia TLS
  de MySQL) y se atraganta contra servidores o poolers que no lo hablan. El
  conmutador de SSL es ahora explícito: off → `sslmode=disable` /
  `ssl-mode=DISABLED` (directo a un arranque en texto plano, sin negociación), on
  → `require` / `REQUIRED`. Un servidor que genuinamente requiere TLS falla ahora
  con un error claro de "activa SSL" en vez de un byte de handshake críptico.

## [1.0.6] — 2026-06-08

### Corregido

- **La sintaxis `--flag=value` de la CLI se ignoraba.** El parser de argumentos de
  arranque solo aceptaba la forma separada por espacios (`--password secret`); la
  forma con igual (`--password=secret`) no coincidía con el flag y el valor se
  descartaba silenciosamente — así que un lanzamiento ad-hoc como
  `huginndb.exe --host … --password=…` creaba el perfil pero reportaba "no
  --password given". El parser acepta ahora ambas formas para cada flag
  (partiendo por el primer `=` para que los valores que contienen `=`
  sobrevivan), con pruebas unitarias que cubren ambas grafías.

## [1.0.5] — 2026-06-08

### Cambiado

- **El diálogo de conexión es ahora un gestor maestro/detalle** (la misma
  disposición que el diálogo de preferencias): un raíl izquierdo lista cada
  conexión guardada con un punto "conectado" en vivo y una entrada "Nueva
  conexión", y el panel derecho edita el perfil seleccionado mediante las
  pestañas General / Túnel SSH. El pie incluye Probar, Conectar (guardar + abrir
  el pool), Borrar (respetando `confirmDestructive`) y Guardar. Abrir desde el
  `+`/editar de la barra lateral sigue funcionando; conectar desde el gestor
  enfoca la conexión en la vista principal. Importar/exportar perfiles viven en la
  cabecera del gestor, y Archivo → "Gestionar conexiones" abre ahora este gestor
  (enfocado en la conexión actual) en vez del antiguo modal envoltorio de lista,
  que se ha eliminado.

### Añadido

- **Los logos oficiales de bases de datos reemplazan las iniciales del driver.**
  Las listas de conexión, el menú de archivo, el desplegable de la barra de estado
  y el gestor de conexiones muestran ahora las marcas de PostgreSQL / MySQL /
  SQLite (incluidas localmente, sin CDN) sobre una tarjeta clara para que los
  logos más oscuros sigan siendo legibles en ambos temas.
- **El logo de la app corona ahora la pantalla de bienvenida del espacio de
  trabajo vacío**, sobre la pista "huginndb — selecciona o crea una conexión".
- **La conexión activa es ahora visible de un vistazo.** El control de conexiones
  de la barra de estado muestra el nombre y el logo de la conexión actual (en vez
  de un mero recuento), y tanto ese desplegable como el menú Archivo marcan la
  conexión enfocada con un check.
- **El panel de previsualización de celda se puede desactivar.** Una nueva
  preferencia `grid.cellPreview` (Ajustes → Rejilla de datos) controla si el panel
  flotante de previsualización de valor aparece al seleccionar una celda. Con él
  desactivado, el clic simple queda como pura navegación; el editor pesado sigue
  accesible vía doble clic y el menú contextual. Por defecto activado (el
  comportamiento histórico).
- **`grid.truncateLongTextAt` se expone ahora en Ajustes** y se aplica de verdad:
  la rejilla limita el texto renderizado de una celda al número de caracteres
  configurado (0 lo desactiva) para que un valor de varios MB no infle el DOM. El
  valor completo sigue disponible en la previsualización/editor.

### Corregido

- **Varias preferencias eran no-ops silenciosos.** Se auditó cada conmutador y se
  cablearon los que no se respetaban:
  - `grid.nullDisplay` — la cadena NULL configurada se renderiza ahora tanto en la
    rejilla de datos como en el panel de previsualización de celda (antes
    hard-codeada `NULL`).
  - `grid.zebraStripes` — se aplican los fondos de fila alternos (se ignoraba).
  - `grid.stickyHeader` — la cabecera de columna solo se fija cuando está activado
    (antes siempre fija).
  - `grid.defaultPageSize` — las nuevas pestañas de tabla abren al tamaño de página
    configurado (antes hard-codeado a 100); el desplegable de tamaño de página
    incluye valores personalizados.
  - `ui.queryHistoryLimit` — el buffer circular del historial de consultas respeta
    el tamaño configurado (antes hard-codeado a 50).
  - `ui.confirmDestructive` — desactivarlo ahora sí salta las confirmaciones de
    borrado (borrar conexión, borrar consulta guardada, borrar filas); la guarda
    de teclear-el-nombre de `DROP TABLE` se mantiene intencionadamente al margen.
- **Ctrl+S en el editor lateral acoplado no limpiaba la guarda de cambios sin
  guardar.** Cuando una celda estaba seleccionada con el panel lateral abierto, el
  panel flotante de previsualización de celda era el que capturaba Ctrl+S y
  persistía *su* valor obsoleto (pre-edición), así que las ediciones del panel
  lateral no se guardaban y su línea base sucia nunca se reiniciaba — moverse a
  otra celda hacía saltar entonces el diálogo de descartar cambios. El panel
  lateral posee ahora Ctrl+S (fase de captura, con precedencia sobre la
  previsualización): guarda su propio buffer en el sitio, reinicia la línea base y
  mantiene el panel abierto para que puedas seguir sin el aviso.
- **El editor de detalle de la Consola ignoraba las preferencias del editor.**
  Sigue ahora el tema de Monaco, la familia de fuente y el tamaño de fuente
  configurados en vez del modo claro/oscuro de la app y una fuente fija.
- **El autoconectar por CLI no hacía nada para los lanzamientos ad-hoc y fallaba
  silenciosamente.** El manejador de argumentos de arranque estaba supeditado a
  tener al menos un perfil guardado, así que los lanzamientos
  `--host/--port/--database/--driver/--user/--password` se saltaban por completo
  en una máquina sin perfiles; además se tragaba cada error, así que un nombre de
  perfil mal escrito o una conexión fallida no producían feedback. El manejador se
  ejecuta ahora una vez al arrancar independientemente de la lista de perfiles,
  espera un refresco de perfiles antes de emparejar `--connect-profile` por
  nombre/id, y reporta los fallos (perfil no encontrado, error de conexión,
  configuración ad-hoc) en el panel de Consola. El backend además hace eco de los
  flags parseados a stderr al arrancar (contraseña redactada) para que un
  lanzamiento por terminal pueda confirmar que los argumentos llegaron.
- **El túnel SSH no recurría a un puerto alternativo cuando el puerto local fijado
  estaba tomado con acceso exclusivo.** El respaldo ante colisión de bind solo
  reconocía `AddrInUse`; en Windows un puerto tomado por otro túnel/socket abierto
  en uso exclusivo — o dentro de un rango reservado (reservas de `netsh` de
  Hyper-V/WSL) — aparece como `WSAEACCES` (`PermissionDenied`), que se colaba y
  rompía la conexión. El respaldo cubre ahora también `PermissionDenied` y
  `AddrNotAvailable`, reintentando en un puerto asignado por el SO. La
  reasignación se registra en la Consola (no solo en stderr) para que no sea
  invisible.

## [1.0.4] — 2026-06-06

### Añadido

- **Flag `--password`/`--pass` de la CLI y alias `--user`.** La contraseña se
  puede suministrar ahora por línea de comandos tanto para `--connect-profile`
  (sobrescribiendo el secreto guardado en el llavero) como para lanzamientos
  ad-hoc; cuando está presente la app autoconecta sin el diálogo de contraseña. La
  contraseña se usa **solo en memoria** — se pasa directamente a `connect` y nunca
  se escribe en el llavero del SO. `--user` se acepta como alias de `--username`
  para coincidir con la grafía usada por `psql`/`mysql`.

### Corregido

- **Los títulos del panel principal seguían en inglés bajo una interfaz en
  español.** Los paneles del dockview exterior (Esquema, Guardadas, Espacio de
  trabajo, Consola, Celda) tenían títulos en inglés hard-codeados, horneados en la
  disposición persistida, así que nunca seguían el idioma seleccionado. Los
  títulos se obtienen ahora de i18n, se reaplican tras una restauración de
  disposición y se actualizan en vivo cuando cambia el idioma. Las casillas Vista
  → Paneles usan las mismas etiquetas traducidas. Los fallbacks de las pestañas
  internas del espacio de trabajo (las etiquetas por defecto `Query`/`Table` y el
  sufijo `(structure)` en las pestañas del editor de estructura) están ahora
  localizados también.

- **`LONGTEXT`/`TEXT` de MySQL se renderizaban como un blob hexadecimal.** sqlx
  nombra una columna `LONGBLOB`/`BLOB` (en vez de `LONGTEXT`/`TEXT`) a partir del
  flag de columna `BINARY` a nivel de protocolo, que el servidor a veces fija en
  columnas de texto reales dependiendo del charset/collation — así que un campo
  `LONGTEXT` podía aparecer como un volcado hexadecimal (HeidiSQL lo mostraba como
  texto). El decodificador prueba ahora primero una decodificación `String` UTF-8
  y solo recurre a hex para bytes genuinamente no-UTF-8.

## [1.0.3] — 2026-06-03

### Añadido

- **Indicador de paleta de comandos en la barra de estado.** Un pequeño chip
  `Ctrl+K` aparece ahora en la esquina inferior derecha de la barra de estado.
  Al hacer clic abre la paleta de comandos directamente; al pasar el ratón
  muestra el tooltip completo ("Paleta de comandos (Ctrl+K)").

- **Paleta de comandos (`Ctrl`/`Cmd`+K).** Un lanzador centrado en el teclado
  para las acciones que normalmente quedan escondidas en menús: cambiar o
  conectar una base de datos, abrir una tabla del esquema de la conexión activa,
  empezar una consulta, cambiar el tema o el idioma y abrir Preferencias.
  Construida sobre el diálogo de Radix ya incluido más una lista filtrada, sin
  dependencias nuevas. Como Monaco se traga `Ctrl`+K dentro del editor, el editor
  de consultas registra su propio comando para que la paleta se abra
  independientemente del foco (gotcha #9).
- **Desplegable de conexiones activas en la barra inferior.** La lista de
  conexiones abiertas separada por comas pasa a ser un desplegable: las
  conexiones vivas arriba (clic para ir a su espacio de trabajo, o desconectar
  en línea) y los perfiles guardados pero inactivos abajo para conexión rápida.
  Conectar / desconectar replican exactamente el flujo del menú Archivo.
- **Barra inferior enriquecida.** Añade un **contador de selección** de varias
  filas en vivo, un indicador de **solo lectura** para las pestañas de resultado
  de consulta, un **historial de consultas** desplegable y clicable (abre una
  consulta reciente en una pestaña nueva, o la copia cuando su conexión está
  desconectada) y conmutadores rápidos de **densidad de filas** y **claro/oscuro**.
- **Notas del parche en Preferencias → Acerca de.** Un lector por versión que
  toma su contenido del `CHANGELOG.md` incluido, con la versión instalada
  seleccionada por defecto. Cuando el idioma de la interfaz es español lee un
  `CHANGELOG.es.md` paralelo, recurriendo al texto en inglés para cualquier
  versión que aún no esté traducida.

### Changed

- **Acento de marca según el tema.** La paleta, antes totalmente neutra, gana un
  color de acento saturado reservado para acción / estado: botones primarios,
  anillos de foco, enlaces y los marcadores de conexión activa. Es un token
  `brand` por tema (themes.ts): los temas neutros Oscuro / Claro reciben un azul
  (`#0f83fd`) mientras que los temas con carácter (Claude, Solarized, Dim, Alto
  contraste) conservan el suyo. Los temas personalizados guardados antes de que
  existiera el token heredan un valor por defecto en CSS en vez de romperse. Una
  regla `prefers-reduced-motion` reduce las transiciones para quien pida menos
  movimiento.
- **Disposición de ventanas "vista isla".** El armazón de paneles exterior
  (Esquema / Guardadas / Espacio de trabajo / Consola) ahora coloca sus paneles
  como tarjetas separadas y redondeadas sobre un fondo sutil en vez de regiones
  pegadas borde con borde, dando a cada ventana un pequeño margen y una
  separación más clara. El área interior de pestañas (tablas y consultas
  abiertas) permanece a ras y sin cambios.

### Fixed

- **CodeLens "▶ Run" duplicado (y sugerencias de autocompletado duplicadas) con
  varias pestañas de query abiertas.** Los `registerCompletionItemProvider` /
  `registerCodeLensProvider` / `registerCommand` de Monaco son globales al
  lenguaje, pero se registraban dentro del `onMount` de cada editor de query, así
  que cada pestaña abierta añadía otro proveedor — N pestañas producían N "▶ Run"
  en cada sentencia y N copias de cada sugerencia. Ahora los proveedores se
  instalan una sola vez por instancia de Monaco (`src/lib/monacoSql.ts`) y
  despachan por modelo mediante un registro en el que cada editor se inscribe al
  montarse y se da de baja al desmontarse.
- **Legibilidad del tab strip interno y seguimiento de la pestaña activa.** La
  pestaña activa (query/tabla) lleva ahora un acento de marca y sigue
  correctamente al panel activo (la pestaña personalizada deriva su estado activo
  del store en vez de un `props.api.isActive` obsoleto), el strip es más alto con
  estados hover más claros, y los iconos de cerrar / dividir (⋮) / nueva query
  (+) se ven bien en temas oscuros.
- **Traducción al español incompleta.** Varios paneles y diálogos seguían
  mostrándose en inglés sin importar el idioma seleccionado. Se migraron al
  sistema i18n el panel de Consola, el editor de consultas (barra lateral de
  historial, tooltips, estados vacíos, pistas de ejecución), el panel de
  Consultas guardadas, el diálogo de Guardar consulta, el input de celda en
  línea, el límite de error de conexión, el menú contextual de la rejilla de
  datos (copiar, copiar fila como, poner NULL, filtrar por / excluyendo valor,
  insertar / duplicar / borrar fila y las acciones masivas de varias filas), la
  barra de la rejilla (filtro de filas, recuento, insertar, chips de filtro de
  servidor) y la barra del navegador de tablas (refrescar, paginación, tamaño de
  página, estado de carga y el diálogo de confirmación de borrado). El español
  cubre ahora toda la interfaz.

## [1.0.2] — 2026-06-02

### Added

- **Importar / Exportar perfiles de conexión.** Exporta todos los perfiles o una
  selección a un archivo JSON portable (`Archivo → Exportar perfiles…` o los
  iconos en _Gestionar conexiones_). Los perfiles pueden incluir credenciales
  opcionalmente: cada contraseña y secreto SSH se cifra individualmente con
  AES-256-GCM, con clave derivada vía PBKDF2-HMAC-SHA256 a 600 000 iteraciones,
  de modo que el archivo es seguro de almacenar o enviar. La importación detecta
  el cifrado, guía por un paso de contraseña cuando hace falta, muestra una
  pantalla de resolución de conflictos cuando los IDs colisionan (sobrescribir /
  omitir / conservar ambos) y siempre asigna UUIDs nuevos a los perfiles
  importados para evitar colisiones en el llavero. Los perfiles importados sin
  contraseña se señalan en el resumen del resultado.
- **Argumentos de conexión por CLI.** HuginnDB se puede lanzar con flags de
  conexión para que herramientas externas lo abran preconectado.
  `--connect-profile <nombre>` autoconecta a un perfil guardado por su nombre
  mostrado; `--connect-profile-id <uuid>` usa el ID estable. Para conexiones
  ad-hoc sin perfil guardado: `--host`, `--port`, `--database`, `--username`,
  `--driver`, `--name` — la app se abre con el perfil precargado y pide la
  contraseña por el diálogo normal (las contraseñas nunca se aceptan por CLI).
  Los flags desconocidos se ignoran silenciosamente por compatibilidad futura.
- **Filtro multi-BD con ámbito (estilo HeidiSQL).** En conexiones
  multi-base-de-datos, el filtro del explorador de esquemas ahora se acota a la
  base de datos activa en vez de buscar en todas a la vez. Expandir una base de
  datos la activa como ámbito del filtro; el placeholder del input pasa a
  "Filtrar en `<bd>`…" y una pista bajo el input confirma el ámbito mientras
  escribes. Abrir una tabla desde resultados entre-BD activa automáticamente esa
  base de datos, colapsa las demás y fija el ámbito. Sin ninguna base de datos
  expandida el filtro vuelve al comportamiento anterior (busca en todas),
  manteniendo el caso de una sola BD totalmente retrocompatible.
- **Editor visual de estructura de tablas (estilo HeidiSQL).** Clic derecho en
  una tabla → _Editar estructura…_ (o _Nueva tabla…_) abre un editor de columnas
  (añadir/quitar/renombrar, tipo, nulabilidad, valor por defecto, clave primaria,
  autoincremento), índices y claves foráneas, incluidas las compuestas. El tipo
  de columna es un combobox editable precargado con los tipos comunes del driver
  para evitar erratas pero permitiendo afinar (p.ej. `varchar(40)`). Sigue un
  modelo de previsualizar-y-aplicar: el backend genera DDL específico del driver
  (PostgreSQL / MySQL / SQLite) que se muestra en una previsualización de solo
  lectura antes de aplicarlo de golpe. En SQLite, los cambios que `ALTER TABLE`
  no puede expresar (tipo / nulabilidad / PK / FK) recurren a la reconstrucción
  canónica de 12 pasos, protegida tras una confirmación destructiva explícita.
  Todos los identificadores se validan antes de entrecomillar; los tipos y
  valores por defecto pasan por una lista de permitidos conservadora.
- **Editor de celda en panel lateral (estilo JetBrains).** Los valores de celda
  grandes ahora pueden editarse en un panel acoplado a la derecha en vez de un
  diálogo centrado. Se llega vía clic derecho → _Abrir en editor lateral_, o el
  nuevo botón _Mover al panel lateral_ dentro del editor modal (que arrastra el
  buffer en curso). Una nueva preferencia _General → Editor de celda_
  (`cellEditorMode`: Diálogo / Panel lateral) elige dónde se abre el editor al
  expandir una celda. El panel es un panel dockview real, así que se redimensiona,
  acopla y flota como los demás.
- **Selección de varias filas con copia y borrado masivos.** Selecciona varias
  filas como en el explorador de archivos de tu sistema: `Ctrl`/`Cmd`+clic
  alterna filas individuales y `Mayús`+clic extiende un rango contiguo. El clic
  derecho sobre la selección ofrece _Copiar N filas como ▸ JSON / SQL INSERT /
  SQL UPDATE_ (reutilizando los formateadores por fila ya existentes) y _Borrar N
  filas_. Todo borrado —individual o masivo— pasa por el mismo diálogo de
  confirmación. La selección se indexa por clave primaria, así que sobrevive a la
  ordenación, el filtrado en cliente y los refrescos (solo disponible en tablas
  con clave primaria).
- **La disposición dividida/flotante del espacio de trabajo ahora persiste por
  conexión.** Una disposición de dos paneles (o flotante) dentro de un espacio de
  trabajo se captura como un blob `toJSON()` de dockview en `tab_state.json`
  (`internalLayout`) y se restaura con `fromJSON` al reabrir, en vez de volver
  siempre como paneles en pestañas simples. Solo se guarda cuando existe una
  división real; ante cualquier deriva de la disposición vuelve al modo de
  pestañas por defecto.

### Fixed

- **Editar una celda `BIT` de MySQL escribía basura.** `update_cell` envía el
  valor como literal de texto y deja que el driver lo convierta. Para `BIT`,
  MySQL lee la cadena `"1"` como el byte ASCII `0x31` (el carácter `'1'`) en vez
  del entero 1, así que guardar una celda BIT la corrompía silenciosamente —
  mientras que `VARCHAR`/`TEXT` funcionaban porque aceptan la cadena directamente.
  El frontend ahora reenvía el tipo crudo de la columna a `update_cell`, que
  envuelve el placeholder en `CAST(? AS UNSIGNED)` para columnas `BIT` de MySQL
  (seguro ante NULL), forzando la interpretación numérica. PG/SQLite no cambian.
- **`TINYINT` de MySQL (y otros anchos enteros no-`i64`) se mostraban como
  `NULL`.** sqlx asigna cada ancho entero de MySQL a un tipo Rust específico
  (`TINYINT` → `i8`, `… UNSIGNED` → `u8`/`u32`/`u64`, …) y rechaza un `try_get`
  con tipo distinto, así que `try_get::<i64>` fallaba para todo lo que no fuera
  compatible con signed-64-bit y la celda colapsaba a `NULL` — la misma clase de
  bug arreglada antes para `BIT`. `mysql_value` ahora prueba en cascada los
  anchos con y sin signo antes de rendirse a `NULL`, de modo que `TINYINT`/
  `SMALLINT` y las columnas sin signo muestran su valor real. `TINYINT(1)`/`BOOL`
  siguen decodificándose como booleanos (esa rama queda por encima de la
  comprobación genérica de `INT`).
- **Panel de conexión en blanco al limpiar un filtro multi-BD.** En una conexión
  multi-base-de-datos, escribir un filtro y luego limpiarlo podía dejar en blanco
  todo el panel de esquema (la barra exterior Archivo/Vista/Espacios seguía
  visible). Causa raíz: un `useMemo` en el explorador de una sola base de datos
  quedaba _por debajo_ del early-return `if (!cs) return`, así que cuando el
  segmento de esquema por conexión pasaba brevemente a `undefined` al desmontarse
  exploradores anidados, React renderizaba un número distinto de hooks entre
  renders y lanzaba un error. El hook ahora va por encima del early-return
  (recuento de hooks constante) y la agrupación es estable por referencia. Un
  nuevo `ConnectionErrorBoundary` envuelve los paneles de esquema y de espacio de
  trabajo para que cualquier futuro fallo de render degrade a una tarjeta de
  error legible con reintento en vez de una pantalla en blanco.

## [1.0.1] — 2026-05-30

Primera versión de parche. Arregla el renderizado de `BIT` de MySQL que la 1.0.0
publicó roto, y reelabora la edición de celdas de la rejilla hacia un flujo
en-línea-primero con un zoom de fila persistente estilo HeidiSQL. El estado en
disco no se toca.

### Added

- **Edición de celda en línea.** Hacer doble clic en una celda de la rejilla
  ahora la edita en el sitio con el mismo input de una línea usado por la fila
  borrador de inserción, en vez de abrir siempre el gran diálogo de Monaco. Un
  botón de _expandir_ en el editor en línea (y el F11 existente en la
  previsualización de celda) escala al modal completo para valores JSON / largos
  / multilínea. Las columnas de clave foránea conservan su combobox en línea; los
  resultados de consulta de solo lectura siguen abriendo el modal como visor. El
  input simple + el control `∅` de poner-NULL es ahora un componente `CellInput`
  compartido reutilizado por la fila borrador y la edición en línea.
- **Zoom de fila persistente.** La rejilla respeta `gridPrefs.rowHeight` (un zoom
  estilo HeidiSQL): `Ctrl` + rueda del ratón sobre la rejilla y los botones
  `+`/`−` en la barra de la tabla agrandan o encogen a la vez la altura de fila,
  el relleno y el tamaño de fuente. El nivel se guarda en `prefs.json` y
  sobrevive a los reinicios.

### Fixed

- **Las columnas `BIT` de MySQL se mostraban como `NULL`.** `sqlx` se niega a
  decodificar un `Vec<u8>` de una columna `MYSQL_TYPE_BIT` (su comprobación de
  compatibilidad de tipo blob solo acepta BLOB/STRING/VARBINARY), así que el
  valor colapsaba a `NULL` en la rejilla aunque la fila tuviera un valor real.
  `mysql_value` ahora lee los bytes directamente del `ValueRef`, plegándolos en
  big-endian a un entero (`BIT(1)` → 0/1, `BIT(n)` más anchos → su valor
  numérico). Los booleanos (`BOOL` / `TINYINT(1)`) también se decodifican ahora
  antes de la comprobación genérica de `INT`, que antes los ensombrecía.

## [1.0.0] — 2026-05-29

Primera versión estable. El ciclo alfa (0.x) se cierra con el espacio de trabajo
convertido en una superficie estilo editor de código, el explorador
multi-base-de-datos volviéndose instantáneo en la primera pulsación, y dos
defectos específicos de MySQL corregidos. Los datos existentes en disco
(`profiles.json`, `tab_state.json`, `prefs.json`) se conservan sin migración. A
partir de aquí el proyecto sigue SemVer.

### Added

- **Espacio de trabajo estilo editor.** Las pestañas de tabla y consulta abiertas
  ahora viven en una instancia dockview anidada en vez de una tira de pestañas
  plana, así que el espacio de trabajo se comporta como un editor de código: las
  pestañas se pueden dividir horizontal o verticalmente, arrastrar entre grupos y
  sacar a una ventana flotante. Las pestañas también se pueden cerrar con clic de
  rueda (botón central) además del botón X. Cada pestaña expone también un menú
  explícito `⋮` con _Dividir a la derecha_, _Dividir abajo_, _Flotar en ventana
  nueva_ y _Cerrar_ para quien prefiera acciones de menú al arrastrar y soltar.
  `useTabs` sigue siendo la fuente de la verdad —los paneles dockview se
  reconcilian contra él— así que la restauración de pestañas por conexión sigue
  funcionando. La geometría de división/flotación es solo de sesión; las pestañas
  restauradas vuelven en la disposición de pestañas por defecto.
- **Las columnas `BIT` de MySQL ahora son configurables en la rejilla.** Una
  nueva preferencia **Visualización de BIT** (Ajustes → Rejilla) renderiza los
  valores `BIT` como `true`/`false` (por defecto) o `0`/`1`. El backend siempre
  envía el valor como número, así que alternar la preferencia re-renderiza sin
  re-consultar.

### Changed

- **El filtrado multi-base-de-datos ahora es instantáneo.** El filtro a nivel de
  conexión solía desplegar `openDatabaseView` + `list_tables` por cada base de
  datos del servidor en la _primera_ pulsación, así que la búsqueda inicial en un
  servidor con muchas bases de datos se atascaba durante segundos. Una conexión
  multi-BD ahora precalienta toda su caché de tablas en segundo plano en cuanto se
  conoce la lista de bases de datos (`warmDatabases` en `src/stores/schema.ts`),
  con concurrencia acotada para no abrir todos los pools a la vez. El filtro lee
  directamente de esa caché; una línea de progreso sutil muestra cuántas bases de
  datos quedan. El prefetch bajo demanda anterior se conserva como respaldo para
  las bases de datos que el precalentado aún no haya alcanzado.

### Fixed

- **El arrastrar y soltar HTML5 en el espacio de trabajo estaba completamente
  roto en Windows.** Arrastrar una pestaña del editor producía el cursor de "no
  se permite soltar" por toda la pantalla — no aparecía overlay de destino, nada
  aceptaba la soltada. El `dragDropEnabled` de Tauri 2 vale `true` por defecto, lo
  que enruta los eventos de arrastre por el manejador de soltado de archivos del
  SO y se adelanta a los eventos HTML5 en los que se apoyan los listeners
  `Droptarget` de dockview (`tauri-utils` lo documenta literalmente:
  _"Disabling it is required to use HTML5 drag and drop on the frontend on
  Windows"_). La config de la ventana ahora pone `dragDropEnabled: false`.
  HuginnDB no acepta soltado de archivos del SO de todas formas (la ruta SQLite se
  elige por un diálogo de archivo), así que no hay pérdida funcional.
- **El divisor entre grupos de dockview era casi invisible.** `.dv-sash` estaba
  forzado a z-index 1 (para que los portales de Radix siempre lo taparan) y
  tintado con `--border`, que en el tema oscuro se fundía con el contenido del
  panel. Una división vertical parecía no haber hecho nada aunque dockview hubiera
  dispuesto un grupo nuevo debajo. El sash ahora vive en z-index 10 (todavía
  seguro por debajo de Radix en 50) con un tinte de divisor explícito, y el
  relleno de arrastre-encima subió de 0.18 a 0.40 alfa para que los cuadrantes de
  soltado destaquen sobre superficies de Monaco / rejilla.
- **Las acciones "Dividir a la derecha" / "Dividir abajo" del menú `⋮` no hacían
  nada.** Llamaban a `panel.api.moveTo({ position })` sin un `group`, pero
  `DockviewPanelApiImpl.moveTo` fuerza `position` a `"center"` cuando
  `options.group` es undefined — mover el panel al centro de su propio grupo es un
  no-op. Pasar el propio grupo del panel como referencia hace que dockview cree un
  grupo nuevo adyacente en el lado pedido.
- **MySQL/MariaDB lanzaba el error 1064 al filtrar una tabla.** La cláusula de
  búsqueda entre columnas emitía `... LIKE ? ESCAPE '\'` para todos los drivers.
  En MySQL la contrabarra dentro del literal de cadena escapa la comilla de
  cierre, dejándola sin terminar y disparando un error de sintaxis (el filtro aún
  devolvía filas porque las consultas de datos y `COUNT(*)` se ejecutan por
  separado, pero aparecía el banner de error). La cláusula `ESCAPE` es ahora
  específica del driver: MySQL recibe `ESCAPE '\\'` (interpretado como una sola
  contrabarra, igual que `escape_like`), mientras que Postgres/SQLite mantienen el
  `ESCAPE '\'` estándar. Centralizado en un nuevo helper `like_escape_clause`
  usado por el filtro de tabla y la búsqueda de opciones de FK
  (`src-tauri/src/commands/query.rs`).
- **Las columnas `BIT` de MySQL se mostraban como NULL.** `mysql_value`
  (`src-tauri/src/db/values.rs`) no tenía rama para `BIT`, así que el valor
  binario de sqlx caía al respaldo de `String`, no se decodificaba y aparecía como
  NULL. Una rama dedicada pliega ahora los bytes crudos en un entero sin signo
  big-endian y lo envía como número.

# Registro de cambios

Todos los cambios relevantes de HuginnDB se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y el proyecto se adhiere a [Versionado Semántico](https://semver.org/lang/es/) a partir de la `1.0`.

> Nota: este archivo es la traducción al español de `CHANGELOG.md`. Cubre las versiones recientes; las versiones más antiguas se muestran en inglés dentro de la app hasta que se traduzcan.

## [Sin publicar]

### Añadido

- **El visor de documentación ahora tiene secciones.** Una guía era un único
  panel de scroll, lo que dejaba las más largas prácticamente imposibles de
  consultar: `docs/MCP.md` son más de 400 líneas en un panel de 70vh, así que
  averiguar qué exige una herramienta obligaba a bajar a ciegas pasando por la
  configuración de cinco clientes hasta llegar a Seguridad. Cada guía abre ahora
  en una **portada** — su prosa de entrada más una tarjeta por sección — y la
  barra lateral es un árbol: las guías, con la abierta expandida en sus secciones,
  y una sección expandida en sus subsecciones. Al elegir una se muestra esa
  sección sola.

  La navegación se deriva de los encabezados del markdown, no de una lista
  mantenida al lado, y de ahí salen dos consecuencias que merece la pena decir.
  Añadir un `##` a una guía lo añade a la barra lateral sin tocar código. Y la
  barra lateral se traduce sola: el cuerpo en español lleva encabezados en
  español, así que elegir el idioma elige también las etiquetas.

  Los enlaces internos ya funcionan. Un `#ancla` salta a su encabezado — cambiando
  de página primero si el encabezado vive en otra — y un enlace relativo a otra
  guía incluida cambia a ella. Antes los dos se pintaban en color de marca, se
  subrayaban al pasar el ratón y no hacían absolutamente nada al pulsarlos; había
  ocho anclas y cinco enlaces entre guías en ese estado. Uno que apunte fuera del
  conjunto incluido (una hoja de ruta, `SECURITY.md`) abre ahora en GitHub en vez
  de ser un callejón sin salida. Un test comprueba que todas las anclas de todas
  las guías publicadas, en los dos idiomas, resuelven a un encabezado real, así
  que renombrar uno dejando huérfanos sus enlaces entrantes rompe el build en vez
  de pasar desapercibido.

  Arreglado de paso: cambiar de guía conservaba el scroll anterior, así que
  saltar desde el fondo de una guía larga a una corta te dejaba al final de ella.

- **Vistas por el conector MCP: leer, editar y eliminar.** Las vistas eran casi
  invisibles para un cliente de IA. `list_tables` informaba de `kind: "view"` y
  `describe_table` devolvía las columnas de una vista, pero nada podía leer su
  *cuerpo*, ni crear, redefinir o eliminar una — el único recurso era escribir a
  mano una consulta de catálogo por motor con `run_query`, y en MongoDB ni eso,
  porque su parser de `mongosh` no tiene vocabulario DDL y un pipeline
  almacenado era inalcanzable en las dos direcciones.

  Dos herramientas nuevas, y una existente ampliada, en los cinco drivers:
  - `describe_table` añade ahora un objeto `view` cuando la relación es una
    vista — `query` (el cuerpo del SELECT) en SQL, `viewOn` más el `pipeline`
    como texto fuente en MongoDB. Sin herramienta nueva para leer:
    `describe_table` ya conocía las vistas por la mitad de las columnas, así que
    el cuerpo va ahí.
  - `save_view` *(escritura)* crea, redefine o renombra una vista. Recibe solo
    `name` y `query`, y lee ella misma la definición actual para decidir cuál de
    las tres es y cómo expresarla en este motor — `CREATE OR REPLACE` en
    Postgres, `RENAME TABLE` en MySQL, borrar y recrear en SQLite,
    `createView`/`collMod` en MongoDB. Con `preview: true` devuelve las
    sentencias exactas sin ejecutarlas.
  - `drop_view` *(escritura)* elimina una, y rechaza cualquier cosa que no sea
    una vista.

  **El modelo de permisos no cambia** — sin eje nuevo, sin ajuste nuevo. Las dos
  herramientas de escritura son DDL, así que las dos exigen el nivel `full` que
  la conexión ya tenía. Y es la única respuesta coherente, no una preferencia:
  el `CREATE OR REPLACE VIEW` que podrías escribir a mano por `run_query` ya
  está clasificado como DDL, así que una conexión en `data` lo tiene rechazado,
  y una herramienta que permitiera el mismo cambio devolvería justo lo que el
  nivel acaba de negar. Queda una asimetría que conviene conocer: eliminar una
  *vista* pide `full` mientras que borrar *filas* solo pide `data` — la misma
  asimetría que ya existe entre `DROP TABLE` y `DELETE FROM`. El `preview` de
  `save_view` es una excepción de verdad, no un agujero: no ejecuta nada, así
  que está clasificado como lectura y funciona en cualquier nivel.

  MongoDB va por esas mismas dos herramientas en vez de tener su propio par. Un
  cliente de IA no puede ver la diferencia desde la salida de `list_tables`, y lo
  que quiere es una herramienta por verbo; el pipeline viaja como texto fuente y
  lo parsea únicamente el único parser que tiene el producto, así que un
  `ObjectId(...)` dentro de un `$match` sigue dando la vuelta como constructor y
  no degradado a cadena.

  De paso, SQL Server ganó la capacidad de leer la definición de una vista; solo
  *crearla* sigue sin estar soportado ahí. Ver [`docs/MCP.md`](docs/MCP.md).

- **Un sistema de notificaciones propio, en lugar de la configuración por
  defecto de la librería.** Las notificaciones eran la librería de toasts
  montada tal cual: cuatro segundos, abajo a la derecha, una tarjeta
  blanca/negra fija que `index.css` intentaba recolorear desde fuera con unas
  60 líneas de `!important`, y un tick pintado con el azul de marca, de modo
  que una confirmación se leía igual que una acción. Ahora cada decisión
  visual es de `NotificationCard`, que se dispara a través de la nueva fachada
  `lib/notify`: la librería se queda solo como transporte (apilado, las seis
  posiciones, descartar arrastrando, temporizadores, foco) y, al marcarse un
  toast `jsx` como `data-styled="false"`, deja de pintar nada, así que el
  bloque de `!important` desaparece en vez de crecer. La tarjeta es una
  superficie del tema: `popover` sobre `border` con radio de 10 px, un riel
  semántico de 3 px con el mismo grosor en todos los estados (el color es la
  única variable), un medallón de icono de 28 px, la escala `2xs`/`3xs`, la
  rampa de sombras `elevation-*` y un hairline de 2 px que se vacía con el
  tiempo restante y se congela mientras el puntero esté sobre la pila.
  `success` usa por fin `--success` en lugar de `--brand`, e `info` es el
  único estado que gasta el azul de marca.

- **Al pulsar el nombre del archivo en una notificación de exportación se abre
  el explorador con el archivo seleccionado.** Antes la ruta se incrustaba en
  la frase traducida (`"Exportado en {{path}}"`), lo que la volvía imposible
  de seleccionar, copiar o abrir, que es justo lo único que se quiere de ella.
  Un nuevo tipo `file` separa el título de la ruta, dibuja el nombre como un
  control real (`api.revealItemInDir`, sobre el comando `reveal_item_in_dir`
  del plugin `opener`, ahora permitido en `capabilities/default.json`) y
  ofrece «Abrir carpeta» y «Copiar ruta», con la carpeta contenedora debajo.
  Lo heredan todas las exportaciones: tabla, filas filtradas, colección, base
  de datos, perfiles de conexión, entornos, esquemas JSON y temas. Si el
  archivo se movió o se borró, el nombre queda tachado y salta un aviso, en
  vez de un botón que no hace nada en silencio.

- **Las repeticiones se agrupan en una sola notificación con contador.**
  Guardar varias filas apilaba siete tarjetas idénticas; ahora las
  notificaciones iguales que se levantan dentro de una ventana de cinco
  segundos se funden en una, contada, y la política de agrupado vive en un
  único sitio para que la tarjeta en pantalla y la fila del historial no
  puedan contar cosas distintas.

- **Un historial de notificaciones tras una campana en la barra de herramientas.**
  La misma tarjeta comprimida a una fila, agrupada por día, con cuenta de no
  leídas y con cada entrada de archivo todavía pulsable, así que una
  exportación de hace veinte minutos está a un clic del explorador. En memoria
  y por ventana a propósito: es material efímero de la sesión, así que no
  merece un archivo de estado ni un sitio en `prefs.json` (que se reescribe
  con cada `Ctrl`+rueda en la cuadrícula), y una segunda ventana que heredara
  las notificaciones de la principal estaría atribuyéndose trabajo que no hizo.

- **Ajustes → Notificaciones**, sección nueva: la posición como una rejilla de
  seis ventanas en miniatura en lugar de un desplegable (la elección es
  espacial), la duración como preajustes más el valor en milisegundos, si los
  errores esperan a que los cierres, cuántas se ven a la vez, expandir al
  pasar el ratón, la densidad de la tarjeta, el tope del historial y si se
  muestra la campana. Cada fila es direccionable desde la paleta de comandos,
  y la vista previa de la sección dispara una notificación *real*: juzgar seis
  segundos frente a cuatro es exactamente lo que un dibujo no permite.

### Corregido

- **El explorador de esquema de SQL Server nunca llegaba a cargar las columnas
  de una tabla — se quedaba en el skeleton de carga para siempre, sin ningún
  error, en todas las tablas, en todos los servidores.** El fix del timeout de
  conexión de más abajo (sigue siendo correcto, sigue mereciendo la pena) no
  era, en realidad, lo que le pasaba a la mayoría: este es un bug distinto y
  más fundamental en el mismo driver, y explica los reportes de "SQL Server
  simplemente no carga el esquema" en conexiones que por lo demás funcionaban
  perfectamente — ver datos de tablas, ejecutar consultas, todo lo demás
  funcionaba; solo la lista de columnas del árbol nunca aparecía.

  `tiberius::Row::get::<T, _>` es `self.try_get(idx).unwrap()` — hace *panic*
  cuando la variante real de `ColumnData` de la columna no coincide con lo
  que acepta el `FromSql` de `T`, en vez de devolver `None`. El helper `i()`
  de `db::mssql::schema` (usado para leer una columna entera del catálogo de
  ancho desconocido) probaba `i64` → `i32` → `i16` → `u8` con
  `.get(...).or_else(...)`, que se lee como un ensanchamiento gradual pero no
  lo es: el primer intento que no encaja hace panic antes de que la cadena de
  `or_else` llegue a ejecutarse nunca. `sys.columns.max_length` es `smallint`,
  así que `raw_columns` (por donde pasa toda llamada a `list_columns`/
  `table_structure`) hacía panic en `i(r, "max_length")` para la primera
  columna de la primera tabla, siempre — una lectura `i64` nunca puede tener
  éxito contra un `ColumnData::I16`. `list_tables` no se veía afectada solo
  porque su propio uso de `i()` (las estadísticas de filas/bytes) resulta ser
  genuinamente `bigint`, que es por lo que la lista de tablas en sí siempre
  cargaba bien. El `auth_type` de `list_users`
  (`sys.database_principals.authentication_type`, un `tinyint`) tenía el
  mismo panic latente, rompiendo la lista de usuarios del panel de Seguridad
  por el mismo motivo.

  Un panic dentro de la tarea asíncrona de un comando de Tauri nunca llega
  al frontend como una promesa rechazada — la llamada `invoke()` del lado JS
  simplemente se queda pendiente para siempre, indistinguible de un cuelgue,
  que es exactamente por qué esto parecía un problema de timeout y no un
  crash. También explica por qué nada en la batería de tests existente lo
  detectó: el error de lógica de `i()` solo se manifiesta contra un
  `tiberius::Row` real ya decodificado, algo que ningún test unitario
  construye (los campos de `Row` son privados al crate `tiberius`).

  `i()` ahora usa `try_get` y descarta el `Err` de un ancho que no encaja
  (`.ok().flatten()`) en vez de dejar que haga panic, así que la cadena de
  fallback ahora sí cae al siguiente ancho como se pretendía originalmente.

- **SQL Server era el único driver cuyo explorador de esquema podía quedarse
  colgado para siempre en el skeleton de carga, sin ningún error y sin forma
  de reintentar.** Todos los drivers basados en `sqlx` (Postgres/MySQL/SQLite)
  reciben gratis un timeout a nivel de conexión: `db::pool::tuned()` fija
  `.acquire_timeout(ACQUIRE_TIMEOUT)` en sus `PoolOptions`, así que incluso un
  `connect()` inicial contra un host inalcanzable falla a los 30s. `tiberius`
  no tiene ningún ajuste equivalente, y el propio `connect()` de `db::mssql`
  nunca añadió uno: ni el TCP connect llano ni la ida y vuelta UDP del SQL
  Browser (`Reach::Browser`, usado para instancias con nombre) tienen ningún
  timeout a nivel de sistema operativo, así que un host que descarta paquetes
  en silencio — un firewall, o un Browser parado sin puerto estático de
  respaldo configurado — colgaba el intento de conexión indefinidamente.

  Esa carencia era invisible para las consultas normales, que ya corren
  dentro del wrapper `with_timeout` de `commands::schema`
  (`OPERATION_TIMEOUT`, 20s). No era invisible para una **vista por base de
  datos**: el explorador multi-base la abre de forma perezosa, vía
  `commands::connection::ensure_database_view`, y cada comando de esquema
  (`list_databases`/`list_tables`/`list_columns`/`list_indexes`) llama a eso
  *antes* de entrar siquiera en su propio bloque `with_timeout`. Así que la
  primera vez que se expandía una base de datos en el árbol — o la primera
  consulta después de que el reaper de pools cerrara una sesión inactiva —
  SQL Server podía colgar el comando entero sin ningún límite, mientras que
  el intento de conexión equivalente de cualquier otro driver ya tenía uno
  vía `acquire_timeout`. Desde la interfaz esto se veía exactamente como el
  reporte: el árbol de esquema atascado en su skeleton de carga para
  siempre, sin error y sin forma de reintentar, solo con SQL Server.

  `db::mssql::connect` pasa ahora por un pequeño wrapper
  `bound_by_acquire_timeout` que usa el mismo `ACQUIRE_TIMEOUT` de los pools
  de `sqlx`, convirtiendo una conexión colgada en un error `OperationTimedOut`
  claro en vez de un skeleton permanente. Esto cubre tanto la primera
  conexión de una vista por base de datos como cualquier reconexión
  posterior tras el cierre de una sesión por el reaper de inactividad, ya
  que todo camino que abre una sesión TDS nueva pasa por
  `MsSqlPool::acquire`, que es el único sitio desde el que se llama a
  `connect`.

- **Eliminar una «vista» de MongoDB cuyo nombre era en realidad una colección
  borraba todos sus documentos.** MongoDB guarda vistas y colecciones en el
  mismo espacio de nombres, y eliminar cualquiera de las dos es la misma llamada
  `drop` — así que `db::mongo::aggregation::drop_view` era un
  `collection(name).drop()` sin comprobación alguna, y apuntarlo a una colección
  real destruía todos sus documentos informando de éxito. En la práctica era
  soportable porque el único llamante era el explorador de esquema, donde el
  usuario había pulsado una fila que el árbol ya sabía que era una vista. Deja
  de serlo en el momento en que un llamante puede pasar un nombre que solo ha
  adivinado, que es exactamente lo que supone exponer la gestión de vistas por
  el conector MCP — de ahí que la comprobación llegue antes de ese trabajo y no
  junto a él.

  `view_presence` resuelve ahora un nombre a uno de tres estados — ausente, una
  colección, o una vista con su definición ya parseada — en una sola ida y
  vuelta de `listCollections`, y `drop_view` rechaza todo lo que no sea el
  tercero. La comprobación de tipo en sí (`spec_is_view`) es una función pura
  para que se pueda testear sin servidor; trata un spec sin campo `type` como
  una *colección*, porque ese campo solo existe desde MongoDB 3.4 y una
  respuesta que no se reconoce tiene que caer del lado seguro, no del
  destructivo. `read_view` se expresa ahora sobre el mismo helper en lugar de
  repetir la comprobación.

  Un nombre que no existe es ahora un error, en vez del éxito idempotente y
  silencioso de MongoDB. Eso deja al driver coherente con los otros cuatro, que
  construyen todos un `DROP VIEW` pelado sin `IF EXISTS`, y hace que un nombre
  mal escrito lo diga en lugar de informar de que funcionó.

- **Crear un índice de MongoDB dejando el campo «Nombre» en blanco siempre
  fallaba.** El diálogo documenta ese campo vacío como «el servidor lo deriva
  de las claves», pero eso nunca funcionó: `NewMongoIndexSpec::to_document`
  simplemente omitía la clave `name` cuando estaba en blanco, asumiendo que el
  servidor lo derivaría igual que hace el helper tipado
  `Collection::create_index()`. No lo hace: esta app envía los índices
  deliberadamente a través del comando en crudo `createIndexes` en vez de ese
  helper (así una recreación puede validar el spec antes de tocar el
  servidor), y ese comando exige que `name` esté presente. La convención de
  nombre `field_1_other_-1` ya existía en la ruta de lectura (`spec_to_info`)
  pero nunca se aplicaba al escribir. Ahora ambas rutas comparten esa lógica
  mediante un nuevo helper `default_index_name`, así que un nombre en blanco
  siempre resuelve al mismo nombre que el índice acabará teniendo.

- **Una actualización masiva («Actualizar filas que coincidan») sobre una
  columna `BIT` de MySQL fallaba con `1406 (22001): Data too long for
  column`.** Es el mismo fallo que ya se corrigió para la edición de una
  celda y la inserción: un valor de texto plano como `"0"` se guarda como el
  byte ASCII `0x30`, no como el entero 0, a menos que el placeholder se
  envuelva en `CAST(? AS UNSIGNED)`. `update_cell_inner` e `insert_row` ya
  aplicaban ese cast (y su equivalente para SQL Server,
  `CONVERT(varbinary(max), ?, 1)`, en columnas binarias), pero la
  actualización masiva tenía su propio constructor de la cláusula `SET`
  (`build_update_statement` en `commands/bulk.rs`) que nunca recibió ese
  tratamiento y vinculaba cada columna como texto plano sin mirar el tipo.
  Ahora aplica el mismo cast por columna (más el fallback al catálogo cuando
  la caché de esquema está desactualizada), compartido tanto por la vista
  previa como por la aplicación real.

- **La pestaña de consulta contra una conexión MongoDB se titulaba
  `query.sql` y se sembraba con un comentario `-- ...` de SQL**, aunque esa
  pestaña ejecuta en realidad un comando `mongosh`-style acotado
  (`db.<coleccion>.<metodo>(...)`), no SQL — lo que llevó a confusiones reales
  en el equipo al tratarla como si fuera una superficie SQL. Una nueva
  pestaña de consulta contra MongoDB ahora se titula `query` y se siembra con
  un comentario `//`, acorde a la gramática real (ambos casos detectan el
  driver mediante `resolveConnectionDriver`); el título de respaldo al
  restaurar sesión y la etiqueta de idioma en la barra inferior del editor
  siguen la misma regla. La pestaña sigue ejecutando el mismo motor
  `mongosh`-style y conserva el modo de lenguaje `sql` de Monaco (con su
  autocompletado/CodeLens ya conscientes del driver) — solo cambió el
  nombrado, no la superficie de edición.

- **Un origen compartido con secretos cifrados guardaba lo que no debía en el
  llavero del sistema.** `sync_origin` escribía el *sobre* AES-256-GCM en base64
  como si fuera la contraseña, así que todo perfil importado desde ese origen
  fallaba al conectar con un error de autenticación del driver — y la contraseña
  real no era recuperable a partir de ahí. La ruta de descifrado ahora es la
  misma que usa el importador de perfiles (`transfer::land_secrets`), que nunca
  guarda un secreto que no ha podido descifrar; un origen cuya passphrase no
  está disponible deja simplemente el perfil pidiendo contraseña, que es el
  comportamiento documentado (la passphrase viaja por otro canal). Tres tests de
  regresión lo cubren sin tocar el llavero.

- **Eliminado un comando IPC inalcanzable que podía leer cualquier entrada del
  llavero.** `load_password(account)` estaba registrado pero no se llamaba desde
  ningún sitio de la app; aceptaba un nombre de cuenta arbitrario y devolvía el
  secreto guardado. Nada en HuginnDB necesita esa forma — la ruta de conexión
  resuelve su propia clave —, así que el comando y su módulo se han borrado en
  lugar de restringirse.

- **El editor de colores del tema salía entero en inglés**, con cualquier idioma
  seleccionado: los 26 nombres de color y los 4 títulos de grupo eran cadenas
  fijas en `lib/themes.ts`. Ahora son claves i18n, en ambos idiomas.

- **Los números y las fechas seguían el idioma del sistema operativo en vez del
  elegido en Ajustes.** Doce llamadas a `toLocaleString()` no pasaban locale, así
  que una interfaz en español sobre un sistema en inglés mostraba `1,234` y
  `8/21/2026`. Ahora pasan por `formatNumber` / `formatDateTime` / `formatTime`,
  que leen `ui.language`.

- **Importar un entorno ocultaba sus propias conexiones cuando un perfil en
  conflicto se resolvía como «Omitir».** El perfil omitido no aparecía en el mapa
  id-original → id-nuevo, así que el filtro `visible_connections` del entorno
  nuevo lo descartaba, y cualquier binding de JSON Schema que lo apuntara quedaba
  desactivado aunque la conexión estuviera ahí desde el principio. Un perfil
  omitido ahora se mapea a sí mismo.

- **Cada arranque congelaba la ventana durante todo el sync del origen
  compartido — varios segundos de «No responde» con un conjunto de perfiles
  real.** Dos causas, ambas corregidas. `sync_origin` era un comando Tauri
  *síncrono*, así que se ejecutaba en el hilo principal: el que bombea la
  ventana, y el que además tenía que leer el fichero de un recurso de red. Y
  volvía a plantar en el llavero **todos** los secretos publicados en **cada**
  sync, hubiera cambiado algo o no, a ~600 000 rondas PBKDF2 por hueco. Un
  origen que publica treinta conexiones con túnel gastaba así decenas de
  millones de rondas SHA-256 en el hilo de UI en cada inicio, y otra vez cada
  cuatro horas.

  Ahora el comando es `async` con el cuerpo en `spawn_blocking`, y se guarda una
  huella del texto cifrado de cada perfil para reconocer y saltar un secreto que
  no ha cambiado. El salto necesita las dos mitades para ser seguro: solo la
  huella dejaría para siempre sin restaurar una entrada de llavero que alguien
  borró, y solo la comprobación de presencia no detectaría nunca una contraseña
  rotada. Con el conjunto donde se encontró (29 conexiones del origen, 26 de
  ellas con túnel), el segundo arranque pasó de un núcleo saturado y la ventana
  congelada a 0 % y ventana viva.

- **Un `accept()` fallando en el puente MCP podía dejar un núcleo girando
  indefinidamente.** El bucle del listener reintentaba sin condiciones, con el
  argumento de que «un accept fallido es transitorio», y descartaba el error sin
  registrarlo. Eso vale para un cliente que desaparece a mitad del saludo, pero
  no para el agotamiento de descriptores (`EMFILE`/`ENFILE`), que es la razón de
  manual por la que `accept()` falla repetidamente y que no se resuelve hasta
  que algo ajeno libera un handle. Ahora los reintentos escalan hasta un tope de
  un segundo tras unos pocos inmediatos —así el caso transitorio no cambia y el
  persistente no cuesta nada— y el fallo se informa en la Consola en vez de
  desaparecer. Latente, no observado en uso real: apareció al diagnosticar la
  congelación de arranque de arriba.

- **Un documento SQL se dividía mal en sentencias a partir de su primer literal
  de texto.** El divisor que alimenta el CodeLens «▶ Ejecutar» por sentencia
  cerraba una cadena entrecomillada y, en la misma pasada, la reabría con ese
  mismo carácter de cierre: todo lo que iba después de `'…'`, `"…"` o `` `…` ``
  quedaba como una cadena sin cerrar y ningún `;` posterior era un límite. Un
  script de dos sentencias mostraba un solo lens abarcando ambas, e importar un
  volcado `.sql` (que pasa por el mismo divisor antes de `execute_batch`)
  enviaba el fichero entero como una única sentencia, que el protocolo
  preparado rechaza. Los cuerpos con comillas de dólar y los comentarios nunca
  se vieron afectados: solo a los tres caracteres de comilla les faltaba el
  `continue` que los demás contextos ya tenían.

- **Un `;` suelto contaba como sentencia.** `;;SELECT 1;` producía tres, dos de
  ellas ofrecidas para ejecutar por el CodeLens, pese a que el divisor documenta
  que las sentencias vacías se descartan: un punto y coma solo no es espacio en
  blanco, así que recortar no lo detectaba.

- **Al importar un tercer perfil con el mismo nombre se numeraba `(3)`, saltándose
  el `(2)`.** La escalera de renombrado del importador de perfiles reutilizaba un
  único contador para los dos peldaños, así que la secuencia era `nombre`,
  `nombre (imported)`, `nombre (3)`, `nombre (4)`, … Ahora coincide con la del
  importador de JSON Schemas —`nombre (2)` tras `nombre (imported)`— porque ambos
  llaman a la misma función.

- **Los conflictos al importar entornos vienen por defecto en «Omitir» y no en
  «Renombrar»**, igual que en el importador de perfiles. Reimportar tu propio
  export acumulaba `nombre (imported)`, `nombre (2)`, … en cada vuelta; el paso
  de conflictos se sigue mostrando, así que un entorno realmente distinto está a
  un clic de Renombrar u Sobrescribir.

- **«Copiar como ▸ SELECT» no escapaba los delimitadores dentro de un nombre de
  tabla o columna**, generando un fragmento que no parseaba. Ahora usa el mismo
  quoting que los demás formatos de portapapeles.

- **`profiles.json` era el único fichero de estado que se escribía sin
  temporal + rename**, así que un fallo a medias podía dejar truncadas todas las
  conexiones guardadas — y con ellas las entradas del llavero, los bindings de
  JSON Schema y los enlaces a orígenes que se apoyan en esos ids. Ahora todos los
  ficheros de estado JSON pasan por un único escritor atómico
  (`src-tauri/src/state_file.rs`).

- **Tres brazos de `match` que habrían tratado mal en silencio un driver o un
  operador de filtro nuevo.** `empty_table` caía en el `TRUNCATE` de Postgres
  para cualquier caso no listado (SQL Server habría ejecutado una sentencia que
  acepta con otra semántica, y MongoDB una que no tiene), y los brazos de
  comparación y `LIKE` del constructor de filtros caían en `<=` y `EndsWith`. Los
  tres deletrean ahora todas las variantes, así que añadir una es un error de
  compilación.

### Cambiado

- **Las notificaciones duran 6 s en lugar de 4 s y los errores esperan a que
  los cierres.** Los cuatro segundos eran el valor por defecto de la librería
  y nunca daban para leer una ruta o un mensaje del driver; los tipos que
  traen algo que hacer reciben ahora un múltiplo de la duración configurada
  (un aviso el doble, una notificación de archivo el cuádruple, con tope de
  30 s) y un error se queda hasta que se cierra, porque casi siempre trae algo
  que copiar, reintentar o reportar. Ambas cosas son preferencias, y un error
  incluye además una acción «Copiar error» sin coste alguno.

- **Interno: una pasada por todo el proyecto sobre lógica duplicada y
  responsabilidades mal colocadas.** Sin cambios de comportamiento más allá de
  las correcciones de arriba. Lo que merece la pena saber:
  - `db/exec.rs` — la contraparte de ejecución de `db::sql::Dialect`. Doce sitios
    repetían el mismo `match pool { … }`, dos de ellos byte a byte, y uno era una
    reinserción de un decodificador que ya existía 200 líneas más arriba.
  - La introspección de catálogo de Postgres/MySQL/SQLite sale de
    `commands/schema.rs` (1559 → 769 líneas) hacia
    `db/{postgres,mysql,sqlite}/`, replicando `db/mssql` y `db/mongo`. Los 17
    `unreachable!()` han desaparecido.
  - `state_file.rs`, `AppState::pool_for`/`mongo_for`, `Dialect::quote_ident` y
    `Dialect::truncate_stmt` sustituyen entre 9 y 10 copias a mano cada uno.
  - `tab_state::mutate` sustituye catorce cuerpos escritos a mano con el mismo
    patrón —tomar el bloqueo de escritura, mutar, clonar el blob entero,
    soltar el guard, guardar— en `commands/{prefs,origins,connection}.rs`. El
    clonar-y-soltar no es incidental: el guardado hace E/S de disco, y mantener
    el bloqueo durante ella dejaría bloqueado a cualquier otro lector mientras
    dura la escritura.
  - `commands::ensure_view` / `commands::entry_sink` sustituyen el prólogo de
    siete líneas con `ensure_database_view` que abría cuarenta y cinco comandos
    de nueve módulos, ocho de los cuales además construían a mano el sumidero de
    log de la Consola. Olvidarlo no se nota hasta que una vista de base de datos
    lleva inactiva lo bastante como para que el segador la cierre, así que
    reducirlo a una línea vale más que las 240 líneas que quita.
  - `log_bus::log_sql_sink` es el único sitio donde se construye una entrada SQL
    de la Consola. `commands::bulk` y `db::mongo::query` rehacían a mano la misma
    cadena de seis campos, dos veces cada uno —una por rama del `match`
    `Ok`/`Err`—, mientras `commands::query` se documentaba como la única ruta de
    log. El helper baja junto a `LogEntry`, que es lo que permite usarlo desde la
    capa `db` sin depender hacia arriba de `commands`.
  - `TableQuery` / `TableScan` / `TableFilter` sustituyen los nueve parámetros
    sueltos que el navegador de tablas enhebraba por `fetch_table_data`,
    `count_table_rows`, `export_table_rows`, sus núcleos `_inner` y cuatro
    puntos de entrada de MongoDB. Con ellos se van seis de los catorce
    `#[allow(too_many_arguments)]`. La carga útil IPC no cambia en el cable (el
    predicado va con `#[serde(flatten)]`), y cuatro tests de deserialización
    fijan el JSON exacto que envía la rejilla: un campo que exista a un lado de
    esa frontera y no al otro se descarta sin decir nada.
  - Cuatro primitivas más de la capa de drivers que estaban copiadas en vez de
    compartidas: `db::values::hex` (tres copias privadas idénticas byte a byte,
    cada una con un comentario diciéndolo), `db::exec::ping` (el latido del
    keepalive y la sonda de conexión enumeraban cada uno los cinco drivers),
    `db::mysql::{is_bit_type, bit_cast, normalize_bit_value}` (el razonamiento
    de escritura de `BIT` del gotcha #15, deletreado en seis sitios) y
    `Dialect::rename_stmt` (`rename_table` y `rename_view` solo se diferenciaban
    en la palabra clave de Postgres y en una palabra de un mensaje de error).
  - La fontanería de importación/exportación: `transfer::{check_meta, metadata,
    save_export, disambiguate_name}` sustituyen los mismos cuatro pasos escritos
    una vez por cada tipo de transferencia (perfiles, entornos, JSON Schemas), y
    `resolve_ssh_secret` se comparte con el conector MCP en lugar de repetirse
    allí.
  - Las ocho tools de solo lectura del conector MCP comparten un mismo cuerpo
    `read_tool` (reabrir un pool segado, resolver el destino por base de datos de
    MongoDB, una petición al puente, serializar). Las de escritura conservan el
    suyo: su comprobación de política va entre dos de esos pasos, y la doble
    comprobación entre las dos capas es deliberada. `resolve_mongo_target` deja
    además de hacer un viaje de ida y vuelta por el puente para preguntar «¿esto
    es MongoDB?» en las cuatro tools que no pasan schema e ignoran la respuesta.
  - `QueryResult::{rows, affected, with_total, with_truncated, with_row_types}`
    sustituyen nueve literales de struct que repetían los mismos siete campos, y
    `src-tauri/src/testkit.rs` alberga el fixture de `ConnectionProfile` del que
    seis módulos de test tenían copia privada: así, un campo nuevo en cualquiera
    de los dos es una edición y no nueve o seis.
  - Frontend: `useImportWizard` (tres diálogos), `useAsyncSubmit` (diez),
    `OverlayPalette` + `useListNavigation` (paleta de comandos y conmutador de
    pestañas), `lib/schedule.ts` (tres debounces, dos sondeos), `RefreshButton`
    (cinco), más `lib/grid/pagination.ts` y `lib/grid/exportTable.ts`.
  - `PrefId` se deriva ahora de `Preferences`, así que un id de «ir a este
    ajuste» que no nombre una preferencia real es un error de compilación en vez
    de un salto muerto en silencio.
  - Borrado código muerto: `ConnectPasswordDialog` (92 líneas, ningún
    importador) y sus claves i18n, `useSavedQueries.byTag`, tres constantes sin
    usar y la dependencia `async-trait`.

- **Interno: los cinco ficheros que habían pasado de mil líneas quedan divididos
  por responsabilidad.** Sin cambios de comportamiento más allá de las
  correcciones de arriba. `SchemaExplorer.tsx` 2842 → 73 (sus ocho diálogos a
  `schema/dialogs/`, cada nivel del árbol a su propio fichero,
  `ConnectionActionsMenu` a `components/connection/`, junto al árbol que lo
  renderiza); `DataGrid.tsx` 3592 → 1301 (fuera `GridRow`, los chips de filtro,
  la caja de búsqueda, la fila borrador y `GridToolbar`; la selección de filas,
  el dimensionado de columnas, el zoom con Ctrl+rueda, la lectura de
  preferencias, la edición de celdas, la navegación por teclado y las
  definiciones de columna a hooks bajo `lib/grid/`);
  `ConnectionDialog.tsx` 1761 → 1267 y sus 41 `useState` a 11 (fuera el raíl y
  el modelo del formulario); `TabbedArea.tsx` 1082 → 390 (fuera la cabecera de
  pestaña y la pantalla vacía); `App.tsx` 820 → 530 (fuera el manejo de intents
  de línea de comandos). Dos órdenes se han preservado a propósito y quedan
  documentados donde se aplican: la secuencia del efecto de arranque y los
  contratos de memoización de `GridRow` y de la cabecera de pestaña.

- **Vitest está montado para el frontend** (`pnpm test`) con tests de
  caracterización de los módulos puros de `lib/` y de cada hook extraído, y el CI
  lo ejecuta junto a los trabajos existentes de typecheck y Cargo. 160 tests en
  18 ficheros, incluidos el divisor de sentencias SQL (en el que los tests
  encontraron los dos bugs de arriba), el matcher de puntuación de la paleta de
  comandos y la división `HOST\INSTANCE` de SQL Server, cuyo gemelo autoritativo
  en Rust sí tenía tests desde el principio.

## [1.17.0] — 2026-08-20

### Añadido

- **Una barra de progreso determinista para los diálogos de importar
  perfiles/entornos**, alimentada por un nuevo evento
  `huginndb://import-progress` emitido desde `apply_profile_imports`
  (`src-tauri/src/commands/connection.rs`) una vez por cada perfil a medida
  que recorre la lista exportada. Ahora que la importación corre fuera del
  hilo principal (ver el arreglo del «No responde» más abajo), la ventana se
  mantiene receptiva durante una importación grande, pero el botón
  deshabilitado no daba ninguna pista de si estaba a punto de terminar o
  atascado — una preocupación real ahora que la operación puede tardar
  legítimamente decenas de segundos. `ImportProgressBar`
  (`src/components/connection/dialogs/`) muestra «N de total» y la comparten
  tanto `ImportProfilesDialog` como `ImportEnvironmentDialog`, cada uno
  suscribiendo su propio `listen()` durante la duración de su llamada a
  `doImport`.

- **Acciones masivas «Marcar todo como: …» sobre la lista de conflictos** en
  ambos diálogos de importación (`ConflictBulkActions`,
  `src/components/connection/dialogs/`), para que resolver un lote con
  decenas de perfiles en conflicto — justo lo que produce una importación de
  varios entornos — ya no signifique pulsar Mantener ambos/Sobreescribir/
  Omitir fila por fila. Fija la resolución de todos los conflictos de una vez
  a través del mismo mapa `resolutions` que ya escriben los botones por fila,
  así que no hizo falta tocar nada aguas abajo.

- **Una biblioteca de esquemas JSON definidos por el usuario, y vínculos por
  columna que hacen que el editor de celda entienda de esquemas.** Un HuginnDB
  usado como almacén de configuración acaba con columnas `json`/`jsonb`/`TEXT` que
  contienen documentos de cientos de líneas con un contrato real, aunque no escrito
  en ninguna parte, y el editor de celda trataba todos ellos como JSON anónimo:
  resaltado de sintaxis, una insignia de válido/no válido y nada más. Ahora
  mantienes una biblioteca de esquemas (un nombre, una descripción opcional y el
  documento tal y como lo escribiste, en un `json_schemas.json` propio) más una
  lista aparte de vínculos que dicen a qué columnas se aplica cada uno. Vincula uno
  y Monaco empieza a completar nombres de propiedad, a sugerir valores de
  enumeración, a mostrar la `description` de cada propiedad al pasar el ratón y a
  subrayar los valores que no encajan. El autocompletado y la documentación al
  pasar el ratón son lo que cambia una jornada de trabajo; la validación es la
  mitad más pequeña.

  La biblioteca es **global, no está adscrita a un entorno**, y eso es una lectura
  deliberada de lo que significa un vínculo. Un vínculo dice «la columna de esta
  tabla tiene esta forma», que es un hecho sobre el *servidor*, no sobre si estás
  mirando Producción o Staging. Adscribirla a un entorno daría a la misma tabla un
  esquema en un entorno y no en otro, que es el bug de `visible_databases` (gotcha
  #27) por tercera vez. También vive en un fichero propio y no en `prefs.json`,
  porque el cuerpo de un esquema real son 50–200 KB y `prefs.json` se reescribe en
  cada `Ctrl`+rueda del grid.

- **La validación nunca impide guardar, por construcción.** Nada en la ruta de
  guardado lee los marcadores, y los diagnósticos están configurados con severidad
  de aviso para que una violación ni siquiera *parezca* que bloquea. La base de
  datos es la autoridad; un esquema es una ayuda. El día que el esquema de alguien
  esté ligeramente mal, seguirá pudiendo editar sus propios datos.

- **Una cascada de más-específico-gana, implementada una sola vez, en Rust.** Un
  vínculo nombra una conexión, un esquema/base de datos, una tabla y una columna;
  todos los ejes menos la columna admiten «cualquiera», y tabla y columna aceptan
  un glob simple con `*`, así que una regla puede cubrir `*_json` en todo un
  servidor o exactamente una columna de una tabla. La especificidad va
  `columna > tabla > esquema/base de datos > conexión`, y que la conexión sea el eje
  *más ligero* es la parte contraintuitiva que hace funcionar el caso que motivó
  todo: una regla general sobre una conexión entera debe perder frente a una que
  nombra la tabla y la columna exactas, mientras que entre dos reglas por lo demás
  idénticas debe ganar la fijada — que es justamente para lo que sirve un eje de
  desempate. Así, un esquema por defecto para `configuration` en todas partes más
  una excepción en la tabla cuya forma difiere son dos reglas, no doce. El frontend
  no reimplementa nada de esto: sería una segunda implementación de una sola
  gramática (gotchas #30/#33), y la deriva sería silenciosa, porque un fallo de
  resolución no es un error, es «no ha aparecido el autocompletado», que nadie
  reporta. La resolución es una llamada por pestaña de datos, cacheada por
  relación, así que es la granularidad y no el lenguaje lo que responde a la
  objeción de rendimiento.

- **«Crear a partir de este valor», porque pedirle a alguien que escriba un esquema
  JSON a mano tiene una tasa de adopción cercana a cero.** La insignia redacta uno
  a partir del documento que tienes delante: le pones nombre, revisas el borrador y
  queda creado y vinculado sin salir del editor. Sus reglas están documentadas en
  vez de ser magia, y dos de ellas existen para que no produzca un esquema que
  rechace las filas de las que se redactó: `required` es la *intersección* de las
  claves presentes en todas las muestras, nunca la unión, y un `enum` solo se
  escribe cuando un valor se ha repetido de verdad — tres valores distintos en tres
  filas son un tamaño de muestra, no un dominio cerrado. Siempre declara `$schema`,
  que es funcional y no decorativo: sin él el servicio de lenguaje valida con
  semántica 2020-12 en lugar de draft-07. La salida es estable byte a byte para la
  misma entrada, así que regenerar un esquema produce un diff legible.

- **Tres superficies vinculan una columna, en orden decreciente de uso.** La que
  importa es una **insignia en la cabecera del editor de celda** (tanto en el modal
  como en el panel lateral acoplado), junto a la insignia de JSON válido: nombra el
  esquema resuelto, dice «sin esquema» en bajo contraste cuando no hay ninguno, y su
  desplegable vincula cualquier entrada de la biblioteca, redacta una nueva o
  desvincula. Es la superficie universal: es la única que tienen MongoDB y SQL
  Server. Segunda, una **sección nueva de Ajustes → Esquemas JSON**: la biblioteca a
  la izquierda, el documento de la entrada seleccionada a la derecha en un panel
  Monaco que edita en el sitio y se expande a pantalla completa con F11 en vez de
  apilar un segundo modal, y debajo la tabla completa de vínculos en orden de
  resolución. Tercera, un **campo por columna en el editor de estructura de tabla**,
  deliberadamente acotado — ver *Cambiado*.

- **La tabla de vínculos muestra la cascada en vez de listarla.** Un eje comodín
  dibuja el glifo `*` y nunca una celda vacía, porque una celda vacía se lee como
  «aún sin rellenar», el error de lectura más común en cualquier tabla de
  precedencia. El orden de las filas *es* la precedencia, ya que el backend las
  devuelve ordenadas. Y una caja **«Probar una columna»** responde a la pregunta que
  esta feature va a generar más — *¿por qué no se aplica mi regla?* — a través del
  mismo resolutor que usa el editor, así que la respuesta no puede discrepar de lo
  que ocurre al editar. Un contador de coincidencias en vivo era la alternativa y es
  peor: tendría que recorrer los catálogos de todas las conexiones vivas y aun así
  solo cubriría lo que esté conectado.

- **Export/import de fichero independiente (`meta.kind = "json-schemas"`), más
  inclusión opcional en la exportación de un entorno.** Sin contraseña en ninguno de
  los dos casos: un esquema no contiene secretos ni material del llavero. La regla
  interesante es qué pasa con un vínculo fijado a una *conexión*, dado que el
  identificador de una conexión es un uuid local a la máquina que lo acuñó: al
  importarlo en otra, ese vínculo llega **desactivado**, conservando su ámbito
  original. No se ensancha a «cualquier conexión» (eso cambiaría el significado de la
  regla) ni se descarta en silencio (eso perdería la intención sin que nadie se
  entere), y el asistente de importación dice el número antes de escribir nada. Una
  importación de entorno, en cambio, lo traduce, a través del mismo mapa de
  identificadores original→nuevo que ya usa `launch.visible_connections`.

- **Una guía nueva, `docs/JSON_SCHEMAS.md`** (con su gemela en español), en el
  repositorio y en Ayuda → Documentación. Cubre la vía de 30 segundos, la cascada
  con un ejemplo resuelto de dos reglas, los límites exactos del esquema inferido,
  la advertencia sobre compartir y una sección de «lo que esto no es», que incluye
  los tres comportamientos del servicio de lenguaje lo bastante sorprendentes como
  para convertirse en preguntas de soporte: el `$schema` propio de un documento
  tiene prioridad sobre su vínculo, un solo `$ref` sin resolver impide que se valide
  el documento entero, y nunca se descarga nada de la red.

- **Tres preferencias: validación, autocompletado y ayuda al pasar el ratón.**
  Separadas porque el servicio de lenguaje las separa: un esquema aproximado ya sirve
  para autocompletar mucho antes de que alguien quiera subrayados rojos. Viven en la
  sección de Esquemas JSON y no bajo Editor, la misma decisión que ya toma
  `AppearanceSection` con el grupo de vista de datos. Además, cuatro acciones nuevas
  en la paleta de comandos y tres entradas de salto a preferencia.


- **Los orígenes compartidos pueden ahora publicar y sincronizar de forma
  continua un entorno completo (#108), no solo conexiones sueltas.** Hasta
  ahora `sync_origin` daba por supuesto que el fichero era un paquete de
  perfiles (`meta.kind = "profiles"`); apuntar un origen a una exportación de
  entorno (`meta.kind = "environment"`, el mismo fichero que ya escribe
  `export_environments`) sincronizaba en silencio solo sus `profiles` y
  descartaba todas las entradas de `environments`, ya que `serde_json` ignora
  los campos desconocidos en lugar de fallar. Ahora `sync_origin` lee el tipo
  declarado del propio fichero y, para una exportación de entorno, reconcilia
  un entorno espejo local en cada tirón: lo crea la primera vez y refresca su
  nombre/color/icono/tema y su pertenencia de conexiones
  (`launch.visible_connections`) en cada sincronización posterior. La
  correspondencia entre sincronizaciones se hace por
  `(origin_id, origin_source_id)` — el `Environment.id` del publicador en el
  momento de exportar, un campo nuevo en `ExportedEnvironment` — y no por
  nombre ni por posición en el fichero, que pueden cambiar entre
  sincronizaciones. Un entorno espejo es de solo lectura en el raíl y en el
  selector (solo se renombra, recolorea o borra vía adoptar/retirar,
  exactamente como ya ocurría con un perfil de conexión propiedad de un
  origen) y, si su paquete desaparece en una sincronización posterior, se
  reporta como desaparecido en lugar de borrarse: la misma regla de «reportar,
  nunca destruir por iniciativa propia» que ya seguía el lado de las
  conexiones. Deliberadamente **no** registra automáticamente los orígenes
  anidados dentro del paquete: un fichero compartido nunca debe poder hacer
  que una máquina registre más orígenes por su cuenta, eso queda reservado al
  `import_environment` consciente y puntual.
### Cambiado

- **El editor de celda pasa ahora a Monaco un `path` de modelo estable.** Este era
  el cambio habilitante de todo lo anterior: los esquemas se asocian por `fileMatch`
  contra la URI del modelo, y el `inmemory://model/N` autogenerado que recibe un
  editor pelado no coincide con nada registrable, así que ningún esquema podía
  aplicarse. La ruta lleva qué superficie la posee, porque el modal y el panel
  acoplado pueden estar abiertos a la vez y dos editores que comparten ruta comparten
  modelo: el primero en desmontarse lo destruiría bajo el otro.

- **Los botones de expandir en línea dicen cuándo hay un esquema vinculado**,
  mostrando `{}` en lugar del glifo de expandir y nombrando el esquema en su tooltip.
  El doble clic sigue abriendo el mismo editor en línea de una sola línea (el gotcha
  #12 se mantiene); solo cambian el icono y el tooltip. Un `<input>` de una línea no
  puede ofrecer autocompletado ni validación, así que la única pista útil es que
  merece la pena escalar.

- **Una columna vinculada fuerza el modo JSON del editor**, por encima de la
  heurística de tipo de contenido. Esa heurística solo responde «json» cuando el
  texto parsea, lo que dejaría un documento momentáneamente roto sin ninguna
  validación, precisamente cuando es más útil. Un vínculo es el usuario afirmando que
  la columna contiene JSON.

- **El editor de estructura de tabla gana una afordancia `{}` por columna, acotada
  fuera del DDL.** Un vínculo es metadato local del editor, no un cambio de esquema:
  vive en su propio estado y no en la columna de trabajo, así que no puede colarse en
  el payload de `preview_structure_change` ni volver a disparar la previsualización de
  DDL (gotcha #16). Se guarda en el momento de elegirlo, va detrás de un separador
  discontinuo con la etiqueta `local`, y está desactivado mientras se diseña una tabla
  que aún no existe. Los renombrados de columna se siguen tras un apply correcto, en
  modo best-effort: el DDL ya ha corrido, así que un fallo ahí es un aviso y nunca un
  rollback.

- **`ExportEnvironmentDialog` gana un interruptor opcional «Incluir los esquemas JSON
  y sus vínculos».** Los esquemas son globales, así que esto empaqueta la biblioteca
  completa junto al entorno en lugar de hacerla parte de él: un solo fichero para
  preparar una máquina nueva.

- **Borrar una conexión elimina también los vínculos fijados a ella**, indicando
  cuántos. El identificador de un perfil es un uuid que no se reutiliza jamás, así que
  ese vínculo no puede volver a coincidir: es una regla provablemente muerta y no algo
  inerte pero posiblemente significativo, lo que la convierte en un payload con clave
  que merece ser segado (gotcha #27). La asimetría es lo que lo hace seguro: el
  esquema, el artefacto caro, no se toca nunca.


- **El borrado masivo de conexiones, el borrado de un entorno y la
  eliminación de un origen compartido usan ahora un diálogo de confirmación
  real en lugar del `window.confirm` nativo.** El diálogo para eliminar un
  origen indica además de antemano cuántas conexiones y entornos publicados
  por él quedarán marcados como huérfanos por la corrección de abajo, para que
  «lo que publicó se queda» no sea una advertencia abstracta.

- **Las opciones de importar/exportar del menú Archivo ahora se agrupan bajo
  una cabecera de sección por tipo** (Perfiles / Entornos / Esquemas JSON) en
  lugar de separarse con simples `DropdownMenuSeparator` vacíos. Con seis filas
  «Importar…»/«Exportar…» parecidas seguidas, un separador vacío se leía como
  «límite entre elementos sin relación» y no como «nueva categoría» — reutiliza
  el mismo recurso de cabecera en línea que `ViewMenu` ya aplica a sus grupos
  «Paneles»/«Árbol de esquema». Ahora Importar aparece antes que Exportar en
  las tres secciones (Entornos y Esquemas JSON iban Exportar-luego-Importar;
  solo Perfiles ya seguía ese orden). «Importar entorno…» pasa a llamarse
  «Importar entornos…» (y lo mismo el título del diálogo y del selector de
  fichero), ya que un mismo fichero puede contener más de un entorno, a
  juego con «Exportar entornos…».

- **Rediseño del diálogo de novedades (`WhatsNewDialog`) para que encaje con
  la identidad de marca, y reescritura de su frase principal de la 1.17.0.**
  El diálogo usaba antes un icono `Sparkles` genérico y un párrafo entero
  como frase de cabecera; ahora arranca con el logotipo sobre el fondo de
  tramado (el mismo recurso que usan `AboutSection`, `EmptyState` y la
  pantalla de arranque), de forma que se repinta con el tema activo porque
  cada color es un token semántico. La frase de cabecera es ahora una única
  oración contundente que dice de qué va la versión de un vistazo, en lugar
  de resumir cada novedad. La descripción de cada novedad se recorta a dos
  líneas con un botón «Leer más»/«Leer menos» al estilo WhatsApp
  (`HighlightBody`) — las versiones recientes tienen suficiente matiz como
  para que el texto ocupe 4-5 líneas, y el botón solo aparece cuando el
  párrafo recortado realmente desborda (`scrollHeight` frente a
  `clientHeight`), así que una novedad corta nunca genera un botón que no
  hace nada al pulsarlo.

- **Se ha reconstruido el aspecto del diálogo del editor de celda
  (`CellEditor`) para que encaje con el resto de la app en vez de con un
  resto anterior al rediseño de marca.** Su cabecera era antes una segunda
  tarjeta con su propio borde y sombra flotando dentro del borde del propio
  diálogo — dos contornos anidados que se leían como algo sin sentido, y que
  empujaban el botón de cerrar del diálogo hacia el hueco de bajo contraste
  entre ambos, dejando la `×` casi invisible. La cabecera y el pie son ahora
  a sangre completa con un único `border-b`/`border-t`, el mismo convenio que
  ya usan `SettingsDialog` y el recién rediseñado `WhatsNewDialog`, de forma
  que el botón de cerrar queda directamente sobre la superficie de la
  cabecera con contraste correcto en vez de flotar en una costura.

- **La insignia de esquema JSON en la barra de herramientas del editor de
  celda (`SchemaBindingBadge`, nueva prop `className`) es ahora un botón
  outline propiamente dicho, anclado al borde derecho de la barra**,
  compartiendo `buttonVariants` con el botón «Formatear» vecino en lugar de
  renderizarse como una diminuta píldora en mono/10px que se leía como una
  etiqueta suelta y no como un control. Los estados vinculado/declarado
  mantienen su tinte de marca/aviso, solo que a escala de botón. La píldora
  en línea de `variant="compact"` del editor de estructura (una por fila de
  la tabla) no cambia.

### Corregido

- **Reimportar perfiles de conexión con «sobrescribir» ya no rompe en silencio nada
  indexado por el identificador del perfil.** `apply_profile_imports` acuña un uuid
  nuevo incluso al sobrescribir un perfil existente, algo de lo que antes no dependía
  nada y que por tanto era invisible. Con los vínculos en juego significa que una
  sobrescritura deja de hacer coincidir en silencio todas las reglas fijadas a ese
  perfil: sin error, el autocompletado simplemente desaparece, y el barrido del
  borrado nunca salta porque no se ha borrado nada. La función devuelve ahora el
  subconjunto de sobrescrituras de su mapa de identificadores, y ambos llamantes lo
  usan para reapuntar los vínculos afectados.

- `EnvironmentImportAnalysis` declaraba un campo `totalProfiles` en `src/types.ts`
  mientras que `transfer.rs` envía `total_profiles`. Nadie lo leía, así que nada
  estaba roto, pero la siguiente persona que lo leyera habría obtenido `undefined`.

- **El asistente de importación de entornos reventaba a ventana en blanco en su
  último paso, con «Cannot read properties of undefined (reading 'length')» en la
  consola.** Es el mismo desajuste snake_case/camelCase de un nivel más arriba,
  solo que esta vez algo sí leía el campo: `EnvironmentImportAnalysisEntry.
  connection_count` e `ImportedEnvironment.environment_id`/`origin_ids` no llevaban
  `#[serde(rename_all = "camelCase")]`, así que cruzaban el cable tal cual mientras
  `src/types.ts` e `ImportEnvironmentDialog.tsx` estaban escritos esperando
  `connectionCount`/`environmentId`/`originIds`. El paso de revisión mostraba en
  silencio «undefined conexión(es)»; el paso final, `env.originIds.length`, lanzaba
  directamente, tumbando todo el árbol de diálogos (React no tiene un límite de
  error por encima de `FileMenu`). Reproducido importando un lote de varios
  entornos y eligiendo «Omitir» para cada perfil en conflicto. Ambos structs llevan
  ahora `rename_all = "camelCase"` — los campos `EnvironmentImportResult.
  json_schemas` / `EnvironmentImportAnalysis.total_profiles` un nivel por encima se
  quedan deliberadamente en snake_case (ver los comentarios del código), así que
  esto no es un cambio de nomenclatura general.

- **Eliminar un origen compartido ya no deja huérfano para siempre lo que
  publicó.** `remove_origin` siempre dejaba en su sitio las conexiones (y ahora
  los entornos) que había importado, etiquetadas con un `origin_id` ya
  colgante — deliberadamente, para que un cambio de configuración nunca borre
  en silencio un lote de servidores contra los que alguien tiene trabajo
  abierto. Pero el único mecanismo que llega a ofrecer liberar una de esas
  entradas (el aviso de desaparición de `useOriginSync` → adoptar/retirar) se
  alimentaba exclusivamente de `syncAll()`, que itera los orígenes
  *actualmente registrados*, y un origen eliminado ya no está en esa lista
  antes de poder volver a reportar nada como desaparecido. La conexión (o el
  entorno) se quedaba permanentemente en solo lectura y permanentemente
  imposible de borrar desde la interfaz, sin salida. Eliminar un origen levanta
  ahora ese mismo aviso de inmediato, a partir del estado local y mientras
  todavía se conoce el nombre del origen, reutilizando el flujo existente de
  decidir-después en lugar de inventar un segundo.

- **Importar un lote con muchos perfiles de conexión cifrados ya no bloquea la
  ventana (Windows la marca «No responde») durante toda la importación.**
  `import_environment` e `import_profiles` estaban declarados como comandos
  Tauri síncronos normales, y Tauri los ejecuta directamente en el hilo
  principal de la app en lugar de en el pool de hilos del runtime asíncrono.
  Ambos llaman a `apply_profile_imports`, que ejecuta `transfer::decrypt_secret`
  una vez por cada secreto cifrado: una derivación de clave PBKDF2-HMAC-SHA256
  de 600.000 iteraciones, deliberadamente lenta, con una sal aleatoria propia
  por secreto, así que no hay ninguna derivación compartida que se pueda
  cachear entre ellos. Importar un único perfil nunca sacó esto a la luz;
  importar 13 entornos que compartían un mismo grupo de perfiles de conexión
  (22 de ellos en conflicto con perfiles ya existentes) suponía docenas de
  derivaciones corriendo en serie, cada una costando del orden de cien
  milisegundos o más, bloqueando el hilo principal el tiempo suficiente para
  que Windows reportara la app como colgada. Ambos comandos son ahora
  `async fn`, con la lectura del fichero, el bucle de fusión/descifrado de
  perfiles, el reapuntado de vínculos de JSON Schema y la escritura del
  tab-state movidos a un cierre de `tauri::async_runtime::spawn_blocking`: se
  paga el mismo coste de CPU, pero fuera del hilo que bombea los mensajes de
  la ventana.

## [1.16.2] — 2026-08-19

### Añadido

- **Tres nuevas guías de usuario, en la app y en el repo: Conexiones, MongoDB
  y SQL Server.** Ayuda → Documentación tenía exactamente dos entradas
  (Entornos y el conector MCP), así que la mayor parte de lo que hace la app
  solo estaba documentado en la lista de características del README o no
  estaba documentado en absoluto. Las nuevas cubren, respectivamente: crear
  una conexión por cada driver y qué necesita cada uno, por qué SSL es
  explícito en ambas direcciones, túneles SSH (autenticación, el fallback de
  puerto local, la política de host-key y los dos casos que no se pueden
  tunelizar), qué hace realmente "dejar la base de datos en blanco" en cada
  motor, dónde viven las contraseñas y qué nunca toca disco, las preferencias
  de límite de conexiones y su override por servidor, el keepalive y la
  affordance de reconexión, cada flag de la CLI incluida la forma ad-hoc
  efímera por construcción, exportación/importación cifrada con la salvedad
  de la URI de MongoDB, y los orígenes compartidos con su modelo de amenaza
  real — el dialecto `mongosh` que acepta el editor de consultas y lo que
  rechaza deliberadamente, las reglas de direccionamiento por ruta y
  fidelidad de tipos del editor de documentos, los pipelines de agregación y
  las vistas (incluido por qué se rechazan `$out`/`$merge`), el gestor de
  índices y por qué MongoDB es el único driver que lo tiene, renombrar/mover
  una colección, y una tabla de lo que no está implementado con el motivo —
  y el manejo de `HOST\INSTANCIA` con el SQL Browser, la confianza de
  certificados, la autenticación de Windows, cómo se renderiza cada tipo de
  valor (`decimal` exacto, `money` a través de un double, `bit` como 0/1,
  binario como hex), los detalles de escritura visibles en la Consola, y las
  cuatro superficies aún deshabilitadas.
- **`docs/README.md` como índice de la carpeta docs** (con su gemelo en
  español), separando las guías de usuario de las notas de diseño internas y
  documentando los cuatro pasos para añadir una guía — el fichero, la entrada
  en `docs.ts`, las claves i18n y la ruta `DOC_FILES` de `vite.config.ts` que
  inyecta su fecha de última actualización — además de las restricciones del
  renderizador de markdown integrado en la app. La sección Docs del README
  raíz ahora enlaza a ese índice y a cada guía; antes no mencionaba
  `ENVIRONMENTS.md` en absoluto.
- Las entradas del visor integrado se ordenan por orden de lectura en lugar
  de alfabéticamente (Conexiones → Entornos → MongoDB → SQL Server → MCP),
  ya que el diálogo se abre en la primera.

- **La vista de lista ya puede insertar una fila / documento.** «Insertar»
  quedaba oculto siempre que la rejilla estaba en modo lista, lo que dejaba
  ese modo casi de solo lectura: se podía editar cualquier campo de un
  documento existente y borrarlo, pero añadir uno obligaba a volver a la
  vista de tabla. El borrador se dibuja como una tarjeta fijada encima de los
  documentos — una línea `clave : control` por campo, con exactamente los
  mismos controles que usa la fila borrador de la tabla (marcador de PK
  autogenerada, combo de FK, selector 0/1 para BIT, input plano), ahora
  extraídos a un `DraftCellControl` compartido para que las dos superficies no
  puedan divergir en los detalles que importan (una columna BIT tiene que
  emitir la cadena numérica que espera el `CAST` del backend, gotcha #15). Se
  confirma con la misma llamada `insert_row`: cambiar de modo de vista cambia
  cómo se *dibuja* el borrador, nunca lo que escribe. Dos diferencias
  deliberadas respecto a la fila de la tabla: que el foco salga de la tarjeta
  **no** la confirma (una tarjeta es un formulario, y aloja un selector de
  tipo cuyo popover vive fuera de ella — confirmar al perder el foco
  dispararía el INSERT en el instante en que se abriera ese selector), así que
  Enter o «Guardar» confirma y Esc o «✕» descarta; y en MongoDB cada campo
  lleva su propio **selector de tipo BSON**, enviado como pista de tipo de
  `insert_row`. Esto último es la razón de hacerlo aquí en vez de reutilizar
  la fila de tipos fijos de la tabla: una colección no tiene esquema, así que
  el tipo con el que se guarda un campo nuevo es una *decisión*, e inferirlo
  del texto escribiría un `Int32` en un campo que la colección guarda como
  `Long` — la trampa de fidelidad que el gotcha #29 documenta para las
  ediciones, un paso antes. El conjunto de campos sigue siendo la lista de
  columnas del resultado (en MongoDB, las claves de primer nivel de la página
  actual); los campos extra se añaden al documento nuevo con el `+` por
  documento una vez que existe.

### Corregido

- **A `docs/MCP.es.md` le faltaba toda la sección "Huella de conexiones"**,
  incluyendo "Compartir los pools de la app", y su introducción seguía
  diciendo que el conector _no puede_ compartir los pools de la app de
  escritorio — lo cual dejó de ser cierto cuando llegó la preferencia
  `Share pools with the MCP connector`. Ambas ya están sincronizadas con el
  original en inglés.

- **SQL Server: los valores `decimal`/`numeric` negativos se renderizaban
  como una cadena malformada** (`-18.900000000` volvía como
  `-18.-900000000`). El `Display for Numeric` de `tiberius` formatea la
  parte entera y la fraccionaria por separado —
  `write!(f, "{}.{:0pad$}", n.int_part(), n.dec_part())` — y ambas se derivan
  de la misma mantisa `i128` con signo, así que un valor negativo emite su
  signo dos veces _y_ pierde el relleno de ceros de la parte fraccionaria en
  el mismo aliento: `-18.09` salía como `-18.-9`, `-0.000000001` como
  `0.-00000001`, y un valor menor que 1 perdía el signo por completo
  (`-0.5` → `0.-5`, porque `int_part()` de ese valor es `0`). Un
  `decimal(18,0)` también crecía una cola `.0` espuria. `mssql_value` ahora
  formatea estas columnas él mismo a partir de la mantisa y la escala en
  crudo (`numeric_to_string`) en lugar de llamar a `to_string()`: el signo se
  quita una sola vez, la magnitud se rellena con ceros hasta al menos
  `scale + 1` dígitos, se separan `scale` dígitos por la derecha — sin ningún
  paso por `f64`, que es precisamente la razón por la que estas columnas
  viajan como texto. Afectaba por igual a todo consumidor de un decimal
  negativo: la rejilla de datos, la copia/exportación a CSV/JSON, y el
  conector `huginndb-mcp`, donde se reportó. `first_i64` (la ruta de
  `COUNT(*)`/estimación de filas) también dejó de perder el round-trip por la
  misma cadena rota — lee `int_part()` directamente, ya que la forma
  renderizada de cualquier escala distinta de cero no es algo que
  `parse::<i64>` acepte.

- **La fila pendiente de insertar aparecía y desaparecía al instante cuando se
  iniciaba desde un menú.** Reportado como «la fila borrador parpadea y
  desaparece»; el botón «Insertar» de la barra de herramientas funcionaba, las
  dos entradas de menú (el menú contextual de la fila y el menú de desborde de
  la barra, donde el botón se mueve cuando el panel es estrecho) no. Ambas son
  menús de Radix, y el `FocusScope` de Radix restaura el foco al elemento que
  lo tenía antes de abrirse el menú desde su propio `setTimeout(…, 0)` al
  desmontarse. La rejilla enfocaba la primera celda del borrador en un
  `requestAnimationFrame`, que se ejecutaba *antes* de ese timeout — así que
  Radix se llevaba el foco de vuelta fuera de la fila recién montada, se
  disparaba el manejador de salida de foco de la fila, y un borrador en el que
  nadie ha escrito se cancela en silencio (a propósito: de lo contrario
  enviaría un `INSERT () VALUES ()`). El foco se concede ahora en un
  `setTimeout` encadenado *después* del frame, que siempre queda encolado
  detrás del de Radix, así que el borrador conserva el foco sea cual sea el
  orden en que se intercalen las dos callbacks. El frame sigue siendo lo que
  espera a que la fila esté montada.

- **Enter o Escape dentro de un selector de valores de FK confirmaba o
  descartaba el borrador entero.** El borrador vincula Enter a «inserta esta
  fila» y Escape a «descártala» a nivel de fila, y `FkCombobox` llamaba a
  `preventDefault` en las teclas que maneja pero nunca a `stopPropagation` —
  así que abrir el selector con Enter disparaba el INSERT con una fila a
  medias, y cerrarlo con Escape tiraba el borrador. Ambos manejadores (el
  disparador y el campo de búsqueda del panel) detienen ya el evento en el
  combo, el único componente que lo ha consumido.

- **El estado vacío de la vista de lista era la única pantalla vacía sin
  identidad visual.** Una colección o tabla sin filas renderizaba una línea
  gris «Sin filas» a secas, mientras que la vista de tabla muestra el marco
  compartido `EmptyState` — trama de semitonos, medallón, la marca con su
  glifo por estado — desde el rediseño de marca. La vista de lista usa ya ese
  mismo marco (y también la previsualización de una agregación cuyo pipeline
  no devolvió nada), suprimido mientras hay una tarjeta de inserción abierta:
  la superficie ya no está vacía, es un formulario.

### Cambiado

- **`docs/MCP.md` (+ el gemelo en español) ahora documenta las dos barreras
  de aprobación independientes por las que pasa una escritura**, tras el
  reporte de una conexión con política `full` cuyo cambio de esquema seguía
  rechazándose — por el cliente de IA, no por el conector. Nueva subsección
  "Cuando el cliente bloquea la llamada, no el conector": una tabla para
  distinguir un rechazo del conector (un resultado de tool que nombra la
  política, más una línea en `mcp-audit.log`) de un bloqueo del lado del
  cliente (la llamada nunca llega al conector, así que el audit log queda en
  silencio), por qué el clasificador de modo automático de Claude Code trata
  el DDL contra un servidor real como una migración contra infraestructura no
  reconocida por defecto, y los cuatro remedios del lado del cliente — un
  reintento puntual desde `/permissions`, una petición explícita (la
  intención explícita despeja los bloqueos suaves del clasificador), una
  regla `permissions.allow` para el tool, o entradas
  `autoMode.environment`/`autoMode.allow` que describan la instancia. Todos
  ellos dependen de quien ejecute el cliente; documentarlos no relaja el
  conector, cuya propia política sigue aplicándose después de que el cliente
  apruebe la llamada.

- **`docs/MCP_CONNECTOR_ROADMAP.md`: una sección abierta sobre distribuir el
  conector a través de un marketplace en vez de una instalación por
  máquina.** Registra las tres rutas candidatas y sus veredictos — el
  directorio de conectores de claude.ai no es viable (lista servidores
  _remotos_, y este lee `profiles.json`, el keychain del sistema y la propia
  red del usuario), mientras que el marketplace de plugins de Claude Code y
  una extensión `.mcpb` de Claude Desktop sí lo son — más la restricción que
  comparten (ninguno puede empaquetar un sidecar compilado por destino, así
  que ambos necesitan un lanzador que resuelva el ya instalado) y los dos
  prerrequisitos que merece la pena hacer en cualquier caso: sacar la lista
  de perfiles expuestos de `--connections` hacia el propio estado de
  HuginnDB, y declarar `_meta["anthropic/requiresUserInteraction"]` en los
  tools de escritura. También deja claro por qué "el marketplace gobierna
  mejor los permisos" se reduce a una cuestión de distribución: la
  aprobación ya pertenece por completo al cliente, y la política de
  escritura es un segundo techo, del lado del servidor, aplicado después de
  ella.

## [1.16.1] — 2026-08-18

### Añadido

- **Exportar/importar uno o varios entornos como paquete autocontenido.**
  File → "Exportar entornos…" abre una checklist (por defecto todo
  seleccionado) que escribe un único JSON con, por cada entorno elegido, su
  nombre/color/tema, sus orígenes compartidos registrados (solo nombre y
  ruta — nunca la contraseña de cifrado, siguiendo el mismo modelo de
  amenaza que ya tenía `origins.rs` de mantener el secreto fuera de banda),
  y un único conjunto deduplicado de los perfiles de conexión que
  referencian entre todos (una conexión compartida por dos entornos
  seleccionados se escribe una sola vez, no se duplica). El mismo diálogo
  también se abre preseleccionando una sola fila desde un atajo en
  `EnvironmentSwitcher`. File → "Importar entorno…" lee uno de estos
  ficheros y **siempre crea entornos nuevos** — uno por cada paquete del
  fichero, nunca fusionados ni sobrescritos sobre uno ya existente, así que
  los entornos exportados por un compañero nunca pueden colisionar con tus
  propios orígenes, conexiones o lista de entornos. Quedan deliberadamente
  fuera: pestañas, geometría del dockview y el estado de lanzamiento, que
  son artefactos de sesión ligados a la máquina que los produjo (ver gotcha
  #10) y no parte de la identidad portable de un entorno. El árbol de
  conexiones de cada entorno nuevo queda acotado exactamente a sus propios
  perfiles importados mediante el filtro `visible_connections` ya existente
  (#107), y ninguno se conecta automáticamente. Los conflictos de perfiles
  de conexión se resuelven una sola vez para todo el fichero, reutilizando
  la misma UI de resolución de `import_profiles`
  (sobreescribir/omitir/renombrar); un origen importado cifrado muestra el
  mismo estado de "sin contraseña guardada" que uno recién añadido, resuelto
  en la siguiente sincronización.
- **Objetivo de paquete `.rpm`**, junto a los ya existentes `.deb`/`.AppImage`,
  para distribuciones de la familia Fedora/openSUSE/RHEL. El empaquetador rpm
  de Tauri (el crate `rpm`) es Rust puro — sin `rpmbuild` ni paquetes de
  sistema adicionales — así que se construye desde la misma tanda de release
  en `ubuntu-22.04` sin cambios en CI más allá de la lista de objetivos en
  `tauri.conf.json`. Se añadió también `bundle.license: "MIT"`, ya que una
  cabecera de licencia vacía en un paquete RPM se muestra como "Unspecified".
  Probado mediante `workflow_dispatch` con la etiqueta desechable
  `v0.0.0-test` (ejecución #62): ambas tandas se completaron y el release en
  borrador incluyó un `HuginnDB-1.16.0-1.x86_64.rpm` válido junto al resto de
  artefactos. Eso confirma que la salida del empaquetador está bien formada —
  la instalación/arranque real en una máquina Fedora/openSUSE sigue sin
  verificar (ver el punto 7 de `ROADMAP.md`).
- **Renombrar una colección de MongoDB**, moviéndola opcionalmente a otra
  base de datos en la misma operación. `renameCollection` es un run-command
  sobre la base `admin` que cualifica ambos lados con el nombre de la base,
  así que el movimiento sale gratis con el renombrado: no hay una operación
  "mover" aparte que construir. La entrada aparece en el menú contextual de
  la colección junto a Vaciar/Eliminar, y el diálogo de renombrado incorpora
  un selector de base de destino (solo MongoDB) con un aviso de que un
  movimiento entre bases copia los documentos en el servidor y requiere
  permisos en ambas. `dropTarget` es siempre `false`: renombrar sobre una
  colección existente es un error que el usuario ve, nunca un borrado
  silencioso de lo que hubiera allí. Las vistas se rechazan de antemano con
  un mensaje que dice qué hacer en su lugar — MongoDB no sabe renombrar una
  vista, solo eliminar y recrear, que es también la razón por la que el
  editor de vistas nunca lo ofreció. El renombrado pasa a depender de su
  propia capacidad `supportsRenameTable` en vez de `supportsDdlEditing`: no
  necesita un constructor de DDL, que es justo por lo que MongoDB puede
  tenerlo mientras la edición de estructura sigue siendo de solo lectura ahí.
- **Atajo propio para "Recargar esquema"** (`Ctrl+Shift+R` por defecto),
  reasignable junto a los demás en Ajustes → Atajos. `F5` sigue recargando
  las filas de la rejilla activa; este relee el catálogo.

### Corregido

- **"Actualizar" ahora recarga la base de datos que estás mirando de
  verdad.** En una conexión multi-BD las tablas viven en los slices hijos
  sintéticos `<padre>::db::<bd>`, pero el menú del nodo de base de datos, el
  de la fila de conexión y la paleta de comandos refrescaban el id _padre_:
  volvían a pedir una lista de tablas que nadie pinta (en MySQL el pool padre
  no tiene base seleccionada, así que legítimamente viene vacía) y dejaban
  intacto el subárbol visible. Una tabla creada fuera de la app no aparecía
  por muchas veces que se pulsara Actualizar. El nuevo
  `useSchema.refreshTree` refresca una conexión junto con todas las vistas
  por base abiertas debajo, y el nodo de base de datos refresca su propio
  hijo explícitamente.
- **Actualizar ahora invalida las columnas e índices cacheados.** Solo volvía
  a pedir las listas de bases y de tablas, arrastrando el resto del slice sin
  tocarlo — y como el explorador carga las columnas de una tabla solo cuando
  _faltan_ (para que plegar y desplegar no vuelva a consultar), una columna
  añadida fuera de la app seguía invisible hasta desconectar. Las tablas
  desplegadas se recargan justo después del vaciado, así que un nodo abierto
  vuelve con sus columnas actuales.
- **SQL Server: se acepta `SERVIDOR\INSTANCIA`, en cualquiera de los dos
  campos.** SSMS tiene una única caja "Nombre del servidor" y separa esa
  forma él mismo; HuginnDB no separaba nada, así que pegarla en el campo de
  instancia producía una consulta al SQL Browser que jamás podía casar (el
  Browser solo publica el nombre corto de la instancia) y pegarla en el campo
  de host fallaba en la resolución DNS con un error que no mencionaba
  instancias. Ahora ambos campos se normalizan con `split_instance`, en el
  backend (autoritativo — cubre también la CLI y el conector MCP) y en el
  diálogo de conexión al salir del campo, para que el usuario vea la
  separación en vez de que ocurra en silencio.
- **SQL Server: un SQL Browser parado o bloqueado por firewall ya no impide
  conectar a una instancia nombrada con puerto estático.** UDP 1434 es un
  servicio distinto del puerto TCP de la propia instancia; si el Browser no
  responde, ahora se prueba el puerto indicado en el diálogo antes de
  rendirse, y el fallo informa de ambas causas en lugar de solo la última. Un
  puerto dejado en el 1433 por defecto no se interpreta como puerto estático.
- **SQL Server: el rechazo de "una instancia nombrada no se puede tunelizar"
  se evalúa antes de abrir el túnel SSH**, en vez de después de pagar el
  handshake.

- **Al hacer clic en una fila de tabla del árbol de esquema en casi
  cualquier punto salvo su nombre se expandía la vista previa de columnas
  en lugar de abrir la tabla.** `TableRow` envolvía toda la fila — chevron,
  icono, nombre, punto de "abrir en pestaña" y badge de métrica — en un
  único botón que alternaba la lista de columnas, dejando solo el `<span>`
  del nombre aislado mediante `stopPropagation` para abrir una pestaña en su
  lugar. Todo IDE del que este proyecto toma referencia vincula un clic
  simple en la fila a abrirla, así que apuntar a la fila y caer un píxel
  fuera de ese estrecho `<span>` del nombre seguía sorprendiendo a los
  usuarios con un expandir/colapsar no deseado. La fila ahora renderiza dos
  botones hermanos: uno dedicado solo al chevron que alterna las columnas
  (con etiquetas aria `schema.expandColumns`/`schema.collapseColumns`,
  en/es), y un segundo botón que cubre todo lo demás y abre la pestaña de
  la tabla.

## [1.16.0] — 2026-08-17

### Añadido

- **Los índices de MongoDB ya se pueden inspeccionar y editar, desde un gestor
  de índices dedicado.** Eran visibles pero intocables: la pestaña de
  estructura los listaba en solo lectura, `apply_structure_change` rechaza
  MongoDB, y el analizador de sentencias del editor de consultas nunca ha
  conocido `createIndex`. Gestionar un índice significaba salir de HuginnDB
  hacia `mongosh`. **Índices…** en cualquier colección abre ahora una pestaña
  con el catálogo real, con crear, ocultar, reemplazar y eliminar.
  - **La lista es una herramienta, no un catálogo.** Junto a las claves y sus
    propiedades muestra el **tamaño** de cada índice y cuántas operaciones ha
    servido desde el último reinicio del contador. Un índice con meses de
    actividad y cero usos es uno que nadie consulta y que cada escritura paga
    por mantener — lo más útil que puede decir esta vista, y la razón de que
    no sea solo una lista de nombres. Ambas columnas vienen de
    `$collStats`/`$indexStats`, que necesitan sus propios privilegios, así que
    se omiten en vez de mostrarse como ceros cuando el rol de la conexión no
    puede leerlas.
  - **Ocultar está junto a eliminar, a propósito.** Un índice oculto es
    ignorado por el planificador de consultas mientras el servidor lo sigue
    manteniendo al día, así que el efecto de quitar uno se puede medir y
    deshacer al instante. Eliminar un índice grande y arrepentirse cuesta una
    reconstrucción completa.
  - Crear cubre las claves (dirección o tipo por clave, mediante un selector,
    con un modo de texto crudo para lo exótico), `unique`, `sparse`, `hidden`,
    TTL, expresiones de filtro parcial, collations, pesos de texto y una vía
    de escape para fusionar cualquier opción que el formulario no tenga como
    campo. **Editar es un eliminar más un crear** — MongoDB no puede alterar
    un índice en su sitio — algo que el diálogo indica y una confirmación
    repite antes de ejecutarlo.
  - **Nada de lo que informa el servidor se descarta en silencio.** El
    catálogo se lee de los documentos crudos de `listIndexes` en vez de a
    través del `IndexModel` tipado del driver, que solo conserva nombres,
    nombres de campo y `unique`; toda opción más allá de esas — incluidas las
    que añada un futuro servidor — sobrevive hasta el editor y de vuelta.
    Reutilizar esa forma tipada habría reconstruido `{ createdAt: -1 }` en
    ascendente la primera vez que alguien corrigiera una errata en él.
  - `_id_` se rechaza para eliminar, ocultar y reemplazar por el backend, no
    solo se deshabilita visualmente.

- **Las vistas de MongoDB ya se pueden editar, con un editor de agregaciones al
  estilo Compass.** Hasta ahora una vista de MongoDB se podía consultar pero no
  modificar: `commands/view.rs` rechaza MongoDB a propósito, porque una "vista"
  de Mongo no tiene un cuerpo `CREATE VIEW` que comparar — es un pipeline de
  agregación guardado sobre una colección de origen (`{create|collMod, viewOn,
pipeline}`). El nuevo editor de agregaciones es la superficie paralela, y se
  abre de dos formas: **Nueva agregación…** sobre cualquier colección (un
  pipeline de trabajo, que "Guardar como vista" convierte en una vista real) y
  **Editar pipeline…** sobre cualquier vista (con su pipeline cargado; al
  guardar se ejecuta `collMod`). Eliminar una vista de Mongo también funciona
  ya: `drop_view` tiene ahora una rama Mongo, porque esa operación concreta no
  necesita DDL.
  - **Dos modos sobre un mismo pipeline.** _Etapas_ da a cada etapa su propia
    tarjeta con su propia salida —el pipeline truncado tras esa etapa—, que es
    lo que hace legible una cadena de dieciséis `$lookup` en lugar de un único
    resultado opaco. _Texto_ es el array completo en un solo editor con la
    salida del pipeline al lado. Cambiar de modo es una conversión que pasa por
    el backend (`format_mongo_pipeline`), porque partir un array literal en
    etapas requiere la gramática y el cuerpo de una etapa está lleno de comas.
  - **La barra de etapas es un diagnóstico, no una miga de pan.** Cada etapa es
    un chip, en orden, con el número de documentos que emitió en la muestra
    (`10+` cuando la muestra llegó a su límite). Leída de izquierda a derecha
    muestra dónde muere el pipeline: el `$match` que vacía todo lo que viene
    después se marca en `warning` al llegar a cero, y una etapa con error en
    `destructive`.
  - Las etapas se pueden desactivar sin borrarlas (permanecen en el documento y
    quedan fuera de toda petición, y nunca se escriben en una vista guardada),
    reordenar arrastrando, plegar y cambiar de operador desde el selector —que
    sustituye el cuerpo solo si sigue siendo la plantilla sin tocar, y en caso
    contrario reescribe únicamente la clave del operador, de modo que un clic
    equivocado cuesta un deshacer.
  - **Exportar pipeline** copia las etapas activas como llamada `mongosh`, como
    pipeline a secas o como fragmento `db.createView(…)` —esto último es en lo
    que se convierte un pipeline cuando deja de ser una exploración.
  - Los pipelines se escriben en la misma gramática relajada que ya entiende el
    editor de consultas (claves sin comillas, comillas simples,
    `ObjectId(…)`/`ISODate(…)` y ahora comentarios `//` y `/* */`), analizada
    por ese único parser en Rust: el frontend nunca analiza un pipeline. Al
    releer una vista, su BSON guardado se renderiza como ese mismo código
    fuente (`bson_to_shell_text`), así que un `ObjectId` dentro de un `$match`
    sigue siendo un `ObjectId` y un `NumberLong` sigue siendo un `NumberLong`
    tras abrir y guardar, en vez de degradarse a una cadena o a un `Int32` que
    deja de coincidir en silencio.
  - `$out` y `$merge` se rechazan antes de llegar al servidor: el editor
    previsualiza con debounce mientras escribes, y una "vista previa" que
    sobrescribe una colección a media edición no lo es. Toda vista previa está
    acotada por un `$limit` (10 documentos por defecto, ampliable hasta 50).
  - Un nuevo lenguaje de Monaco colorea por separado las dos cosas que
    significan algo en un pipeline —una clave de operador (`$match`, `$sum`) se
    lee como palabra clave y una referencia a campo (`"$customerId"`, `"$$NOW"`)
    como nombre predefinido—, con autocompletado de etapas, operadores de
    expresión y constructores BSON. Usa los nombres de token que ya estilan
    todos los temas, así que los temas personalizados colorean pipelines sin
    saber que existe.

### Cambiado

- **Todos los temas integrados forman ahora pareja claro/oscuro, y el
  catálogo se recortó y reequilibró en consecuencia.** Se eliminan `Dim` y
  `Solarized Dark` — ambos eran presets de un solo modo de los que no se
  podía salir con el toggle sin acabar en un tema por defecto de HuginnDB
  (ver la entrada de Corregido más abajo), y ninguno tenía identidad
  suficiente para justificar construirle una contraparte. Se añaden `Summer
Dark` (una paleta "playa de noche" que conserva el coral/turquesa de Summer,
  aclarado para una superficie oscura, igual que Claude Dark aclara la
  terracota de Claude Light), `Neon Light` (la contraparte "laboratorio sobre
  papel" de la paleta casi negra de Neon — cada tono saturado se oscurece para
  seguir siendo legible sobre una superficie clara, pero el verde
  primary/brand, el cian de `fk`, el amarillo de `pk`/`numeric` y el rosa
  fuerte de `destructive` mantienen la familia reconocible) y `High Contrast
Light` (el mismo lenguaje de contraste máximo invertido a blanco/negro,
  conservando el mismo amarillo de señal para primary/brand/ring). En total,
  diez temas integrados: HuginnDB, Claude, Summer, Neon y High Contrast, cada
  uno con su pareja claro/oscuro.
  - El editor de 26 colores de Preferencias → Apariencia era una única
    rejilla plana de 2 columnas en orden de declaración — tokens sin relación
    (por ejemplo, `border` junto a `input`, tres filas después de
    `brandHover`) uno al lado del otro sin ninguna agrupación visual. Ahora se
    divide en cuatro secciones etiquetadas — Superficies, Acciones y marca,
    Colores de estado, Bordes y foco — mediante un nuevo export
    `COLOR_GROUPS` en `lib/themes.ts`, de forma que un par
    background/foreground y sus vecinos se leen juntos en vez de tener que
    buscarlos con scroll.
- **Toda la interfaz sigue ahora el lenguaje visual de marca de HuginnDB.** El
  universo del logo —contornos negros suaves, esquinas redondeadas, volumen
  ligero, un único azul eléctrico— se aplica como una capa _contenida_ sobre la
  herramienta keyboard-first existente: las superficies de trabajo (grid, SQL,
  JSON) se mantienen tranquilas y la personalidad aparece en las affordances,
  los estados y las pantallas vacías.
  - Los dos temas por defecto se han repintado con la paleta de marca: una
    rampa slate/navy de cuatro niveles de profundidad (`#020617` → `#0b1220` →
    `#111827` → `#1e293b`) bajo un único acento `#2563eb` en oscuro, y blanco →
    `#f8fafc` → `#eef5ff` sobre bordes `#d6e4f5` en claro. El resto de presets
    (Dim, Solarized, Claude, Neon, Summer, High Contrast) no se tocan.
  - Nuevo token de tema `brand-hover`: el acento bajo el puntero es ahora un
    color real por tema (más claro en temas oscuros, más profundo en los
    claros) en lugar de `brand/90`, que fundía el acento con la superficie
    justo cuando debía iluminarse. Es editable como cualquier otro color en
    Preferencias → Apariencia.
  - Botones: esquinas de 12px, borde de 2px en las variantes rellenas y un
    hover que sube 1px hacia un breve resplandor de marca. Inputs, textareas y
    selects comparten un único tratamiento de foco limpio: el borde se vuelve
    azul de marca con un halo suave de 3px, en lugar del anillo despegado.
  - Menús, popovers, tooltips, selects y diálogos se abren con el mismo
    fundido + escala 98→100% dentro de la banda de movimiento de 150–220ms, y
    se apoyan en la rampa de elevación compartida en vez de sombras ad-hoc.
  - Los destinos de arrastre de paneles, el sash activo y un switch activado
    son azules (son affordances); los bordes de los toasts se codifican por
    color según el resultado con un grosor común, con success por fin verde y
    warning sensible al tema en lugar de un ámbar fijo.
  - La barra de actividad y el rail de entornos marcan la entrada activa con
    una barra redondeada de 4px a ras del borde del rail (azul de marca en la
    barra de actividad, el color propio del entorno en el rail) y tiñen de azul
    el icono seleccionado. Ambos railes y los botones del pie del chrome ganan
    anillos de foco por teclado.
  - La conexión seleccionada en el árbol lleva el mismo rail azul que ya tenía
    la tabla activa, más un borde azul de un píxel; las tarjetas de conexión
    del lanzador suben 1px al pasar el ratón y la activa queda dentro de un
    resplandor azul sutil.
  - Data grid: las cabeceras van en semibold sobre una superficie ligeramente
    elevada, y todos los separadores de celda salen ahora del token `border` en
    lugar de un alpha plano del foreground — una línea más suave y sensible al
    tema. El redimensionado de columnas (tirador, hover, columna en curso) es
    azul como el resto de affordances.
  - **Nuevos temas de editor "HuginnDB Dark" / "HuginnDB Light"**
    (Preferencias → Editor), pintados con la paleta de la app: el fondo del
    editor coincide exactamente con el del panel, la línea activa es un realce
    azul suave con el borde por defecto de Monaco suprimido, las palabras clave
    toman el azul de marca y los números el mismo ámbar que usa el grid para
    celdas numéricas. `huginn-dark` es el nuevo valor por defecto en
    instalaciones nuevas; quien ya eligiera un tema de editor lo conserva.
  - La cabecera del editor de celda es ahora un rail redondeado y ligeramente
    elevado con un icono del tipo de contenido detectado, y el pantalla
    completa es un pequeño chip tipo sticker que por fin muestra su propio
    atajo (F11) en lugar de un icono anónimo.
  - **Las pantallas vacías son ahora una familia**, no cuatro líneas grises sin
    relación: un único marco compartido (`EmptyState`) con un lavado de
    halftone, un medallón contorneado con el glifo y sitio para una pista,
    adoptado por el árbol de conexiones, la consola, las consultas guardadas y
    un resultado vacío.
  - **El nuevo logo comic sustituye a la marca antigua del cuervo/runas en todas
    partes**: se han regenerado desde él todos los tamaños de icono de app e
    instalador (Windows, macOS, Linux, además de los sets de Android/iOS), el
    workspace vacío muestra el lockup completo, la tarjeta de Acerca de lidera
    con la marca sobre un lavado de halftone, las pantallas vacías la muestran
    en su medallón con el glifo de cada estado como chapa en la esquina (sobre
    un campo de puntos que ahora cubre toda la superficie, iluminado por un
    bloom azul bajo la marca) y la pestaña del navegador en dev por fin tiene
    favicon. Los originales viven en el nuevo directorio `brand/`, fuera de
    `public/`, para que 2,5 MB de arte fuente no acaben en cada instalador;
    `public/image/` guarda solo lo que la app pinta, al tamaño al que lo pinta.
  - El icono de Windows se ha rehecho para los tamaños pequeños: el arte se
    recorta a su propio contenido (el margen transparente del original costaba
    ~10% de cada lienzo), cada talla se remuestrea con halvings 2:1 sucesivos y
    un unsharp suave a 32px o menos, e `icon.ico` incluye ahora la escalera
    completa —16/20/24/32/40/48/64/96/128/256—, con las entradas de 20px y 40px
    que Windows pide al 125% y 250% de escalado y que antes tenía que
    improvisar reescalando una vecina. La "H" se lee en la barra de título, la
    barra de tareas y el Explorador en vez de convertirse en un borrón azul.
  - **Nuevo splash de arranque**: la marca sobre un lavado de halftone y un
    bloom azul, en pantalla medio segundo y fuera. Es una capa dentro de la
    ventana existente, no una segunda ventana de Tauri, y nunca bloquea ni
    espera a la restauración de sesión.
  - Microdetalles: los tiradores de redimensionado son redondeados y se vuelven
    azules al agarrarlos; los puntos de estado de conexión llevan un halo suave
    de su propio color (los pilotos del cilindro del logo); saltar a una
    preferencia desde la paleta de comandos la hace parpadear en azul una vez
    antes de asentarse en su anillo; los dos avisos de estado que usaban un
    borde más claro que el resto ahora coinciden.

### Corregido

- **Cambiar entre claro/oscuro en un tema integrado que no fuera uno de los
  dos por defecto de HuginnDB lo reseteaba a `HuginnDB Dark`/`HuginnDB Light`
  en lugar de cambiar a la contraparte propia de ese tema (issue #132).**
  `setActiveMode` buscaba el destino con
  `BUILT_IN_THEMES.find(t => t.id === mode)` — una coincidencia literal
  contra el _string_ de modo `"dark"`/`"light"`, que solo resolvía a los dos
  temas cuyo `id` coincide justo con su modo. Cualquier otro preset (Claude,
  Dim, Solarized Dark, Neon, Summer, High Contrast) no encontraba nada,
  caía en silencio en una rama muerta que mutaba `mode` sobre un tema que
  nunca llegaba a escribirse de vuelta en `customThemes`, y el selector
  claro/oscuro de la barra simplemente dejaba al usuario en el HuginnDB por
  defecto que coincidiera con el modo destino. Se arregla dando a cada tema
  integrado un `pairId` explícito que apunta a su contraparte claro/oscuro
  (`lib/themes.ts`), y haciendo que `setActiveMode` resuelva a través de él
  en vez de adivinar a partir del string de modo. Esto es también el motivo
  por el que ahora cada tema integrado necesita una contraparte real — ver la
  entrada de Cambiado de arriba.
- **Sustituir un icono de la app ya no deja el anterior embebido en el
  binario.** `tauri_build::build()` solo declara `tauri.conf.json` y
  `capabilities/` como entradas de compilación, y cargo rastrea _únicamente_ lo
  que un build script declara — así que cambiar `icons/*` dejaba el crate como
  fresco mientras las dos copias del icono que se hornean al compilar (el
  recurso Win32 del ejecutable y el `default_window_icon` del contexto
  generado) conservaban el arte anterior, sin error alguno y sin que ninguna
  recompilación del frontend lo arreglara. `build.rs` declara ahora los seis
  ficheros de icono, de modo que tocar uno fuerza el reenlazado.
- El marcador del entorno activo en el rail izquierdo nunca se veía: estaba
  desplazado 8px fuera de un botón a ancho completo, lo que lo dejaba más allá
  del `overflow-hidden` del shell. El botón de solo lectura que renderizan las
  ventanas secundarias arrastraba el mismo fallo y se corrige con él.

- **Una "New window" secundaria mostraba todas las conexiones guardadas de
  todos los entornos, sin ningún rail que las distinguiera.**
  `EnvironmentRail` y `EnvironmentSwitcher` ya se ocultaban fuera de la
  ventana principal (gotcha #8 — solo main escribe `tab_state.json`), pero
  nada rellenaba los filtros de visibilidad de conexiones/bases de datos
  (`useUi.visibleConnections` / `databaseVisibility` /
  `collapsedConnections`) en una ventana secundaria tampoco, ya que
  `restoreSession`/`switchTo` estaban ambos bloqueados a la ventana
  principal. Como los perfiles de conexión son globales, no están
  particionados por entorno, el árbol caía a su comportamiento por defecto
  de "sin filtro": mostrar todo. `list_environments` ya devuelve, de solo
  lectura, el `launch` completo de cada entorno, así que el arreglo se queda
  en el frontend: `useEnvironments.load()` ahora siembra los filtros propios
  de una ventana secundaria a partir del entorno que esté activo, y
  `switchTo()` ganó una rama real para ventanas que no son la principal que
  redirige esos filtros localmente — sin tocar nunca `set_active_environment`,
  los pools, las pestañas ni `tab_state.json`. Cada ventana ya tiene su
  propio proceso de JS y su propia instancia de Zustand, así que esto no
  puede filtrarse entre ventanas. `EnvironmentRail`/`EnvironmentSwitcher`
  ahora se renderizan en toda ventana, con crear/renombrar/eliminar/reordenar
  (las acciones que sí escriben el archivo compartido) ocultas fuera de
  main — así que varias ventanas pueden estar cada una en un entorno
  distinto a la vez, de forma independiente.

- **Cambiar el modo de vista de una tabla (tabla/lista) en una ventana lo
  cambiaba en silencio en el resto de ventanas y pestañas abiertas.** El
  conmutador escribía `documentViewMode`, un campo dentro del único bloque
  `Preferences` que el backend difunde a propósito a todas las ventanas al
  guardar (la mayor parte de `Preferences` es efectivamente de toda la
  aplicación, por ejemplo la altura de fila). Se ha movido al estado de
  vista propio de cada pestaña de tabla (`TabViewState`/`PersistedTab`), el
  mismo mecanismo que ya se usa para los filtros/orden/búsqueda de una
  pestaña — ahora cada pestaña guarda su modo de fila de forma independiente
  del resto de pestañas y ventanas, sembrado una sola vez desde el valor por
  defecto global (sin cambios) la primera vez que se abre.

- **El rail de entornos ahora se desplaza, y Tema/Ajustes siguen siendo
  alcanzables.** El rail era una única columna plana con su pie fijado por
  `mt-auto`, que solo fija mientras hay espacio libre. En torno a ocho o nueve
  entornos, los avatares llenaban el rail y empujaban el interruptor de tema y
  el botón de ajustes más allá de su borde inferior, y el `overflow-hidden`
  del shell los recortaba — sin scroll para alcanzarlos y sin ninguna pista de
  que algo se hubiera perdido. Los entornos ahora se desplazan en su propio
  contenedor, y "+", Tema y Ajustes se sitúan en una franja fija debajo. "+"
  se sacó a propósito de la lista que se desplaza: crear un entorno no
  debería significar desplazarse más allá de todos los que ya tienes.

- **Una conexión multi-base de datos dejaba de poder explorarse tras unos
  minutos de inactividad, aunque el árbol la siguiera mostrando como
  conectada.** Expandir una base de datos en una conexión de tipo servidor
  (Postgres/MySQL/SQL Server sin `database` fija) abre un pool sintético por
  base de datos (`<parent>::db::<database>`), y desde la 1.13.0 uno de esos
  que lleva inactivo se cierra por el proceso de fondo tras
  `connections.childIdleTtlSecs` (5 minutos por defecto) — a propósito, para
  que la huella de conexiones de una sesión larga no crezca sin parar. Lo que
  no se tuvo en cuenta es que la conexión _padre_ que el árbol realmente
  refleja se mantiene sana todo el tiempo (su propio keepalive sigue teniendo
  éxito), así que el árbol seguía informando "conectado" mientras el pool
  hijo que el siguiente clic necesitaba de verdad ya no estaba —
  apareciendo como un error `not connected: <id>`, o, cuando el clic solo
  disparaba la lista de columnas, un esqueleto de carga indefinido (el store
  `loadColumns`/`loadIndexes` no tenía manejo de errores, así que una llamada
  rechazada simplemente se quedaba colgada). Cualquier comando que resuelve
  un id de conexión ahora reabre de forma transparente un pool hijo cerrado,
  con las mismas credenciales cacheadas que usó la primera vez, antes de la
  búsqueda habitual — el cierre en sí no cambia, solo su efecto en el
  siguiente clic. Las llamadas de solo lectura a metadatos (`list_tables`,
  `list_columns`, el ping del keepalive, …) ganaron también un tiempo límite
  de 20 segundos, así que un socket que un NAT o un firewall cerró en
  silencio a medias falla rápido en vez de colgarse — antes el único tiempo
  límite en todo el backend protegía el cierre de pools, no las consultas.
  SQL Server necesitó un arreglo más debajo de este: una consulta cancelada
  por ese nuevo tiempo límite podía devolverse al pool como sana con su flujo
  TDS a medio leer — una sesión ahora solo vuelve al pool inactivo una vez
  que su resultado se ha clasificado realmente como dejando el flujo en un
  punto limpio, nunca ante un future cancelado.
- **El conector `huginndb-mcp` podía fallar una llamada por lo demás exitosa
  con `invalid input: empty reply`, de forma más visible contra SQL Server.**
  El fallo está en el puente local que usa el sidecar para reutilizar los
  propios pools de la app de escritorio: toda llamada a una tool empieza con
  un viaje de ida y vuelta `EnsureConnected` cuyo valor de éxito es
  `Value::Null`, y el formato de cable envolvía el payload de una respuesta
  en un `Option<Value>` a secas — que `serde_json` colapsa a "ausente" ante
  _cualquier_ `null`, sea lo que sea que envuelva. Un éxito legítimo con
  `Value::Null` era por tanto indistinguible de no haber recibido respuesta
  alguna. El fallo es independiente del driver — puede darse en la primera
  llamada de cualquier tool contra cualquier conexión mientras el bridge esté
  activo — pero SQL Server fue donde se notó, probablemente porque los demás
  drivers se probaron con el sidecar en su modo independiente (sin bridge),
  donde esta ruta de código nunca se ejecuta. El payload ahora se envuelve un
  nivel más adentro para que el cable pueda distinguir "un valor null" de
  "ningún valor"; la versión del protocolo del bridge se incrementa en
  consecuencia, así que un sidecar antiguo que un cliente mantenga vivo a
  través de una actualización de la app degrada a su propio pool local en vez
  de malinterpretar la nueva forma a mitad de una llamada.

## [1.15.0] — 2026-08-14

### Añadido

- **Los entornos pueden llevar una imagen de avatar propia.** Hasta ahora un
  entorno se dibujaba siempre con sus iniciales sobre el color de acento, lo que
  deja de distinguir en cuanto dos empiezan por la misma letra ("Cliente A" /
  "Cliente B") — justo el caso que el rail existe para hacer reconocible de un
  vistazo. El diálogo de crear/renombrar acepta ahora una imagen: elígela con el
  diálogo nativo de archivos, o suelta un archivo directamente sobre la vista
  previa del avatar. Sustituye a las iniciales en el rail, en el selector de
  espacios de trabajo y en la propia vista previa del diálogo, y el selector de
  la barra de estado también la muestra en lugar de su punto de color (una
  imagen sí se reconoce a 12px, que es la razón por la que las iniciales nunca
  estuvieron ahí). Quitarla vuelve a las iniciales.
  Dónde se guarda: en línea, dentro del campo `Environment.icon` que ya existía
  — como una URL `data:`, así que no hay cambio de esquema ni migración de
  datos. Lo que elija el usuario se recorta cuadrado desde el centro y se
  recodifica a 128px (WebP donde el webview sabe codificarlo, PNG en el resto)
  antes de guardarse, lo que mantiene el payload en pocos KB: `icon` viaja por
  `tab_state.json` en cada escritura del entorno, así que una foto a resolución
  completa engordaría un archivo que la app reescribe constantemente. Guardar la
  imagen en línea en vez de como archivo en el directorio de configuración
  significa que no tiene ciclo de vida propio — se copia, se descarta y se
  escribe junto al entorno, así que no hay huérfanos que barrer ni un segundo
  modo de fallo en el que el JSON apunte a un archivo que ya no está.
  `icon` es la ranura en la que escribía el antiguo selector de iconos de
  lucide, y un entorno que aún guarde una clave de icono heredada sigue cayendo
  a las iniciales igual que desde que ese selector se eliminó: la rama de imagen
  se activa por que el valor sea una URL `data:image/`, no por que el campo no
  esté vacío.
  Un comando nuevo en el backend (`read_image_data_url`) hace la lectura, porque
  el diálogo nativo devuelve una _ruta_ que el webview no puede abrir por sí
  mismo. Valida el formato por los bytes mágicos del archivo y no por su
  extensión, y rechaza cualquier cosa por encima de 12 MB, así que un archivo
  inservible se rechaza con un mensaje claro en vez de convertirse en una URL
  `data:` que ningún `<img>` va a cargar. La ruta de arrastrar y soltar no pasa
  por él — el navegador ya tiene los bytes.

- **Ya se publican artefactos de release para Linux.** Cada release _podía_
  haberlos incluido desde hace tiempo: `bundle.targets` en
  `tauri.conf.json` lista `deb` y `appimage` desde la 1.7.0, y
  `.github/workflows/release.yml` ya tenía tanto la pata `ubuntu-22.04` de la
  matriz como sus dependencias de apt (`libwebkit2gtk-4.1-dev`,
  `libappindicator3-dev`, `librsvg2-dev`, `patchelf`). La pata estaba
  simplemente comentada, así que nunca se compilaba nada y los usuarios de
  Linux tenían que compilar desde el código — el propio README lo decía. Ahora
  está activada, y una build con tag adjunta `.deb` + `.AppImage` de `x86_64`
  junto al instalador de Windows, con una nueva sección "From a release
  (Linux)" en el README que cubre ambos. `ubuntu-22.04` es una elección
  deliberada frente a `ubuntu-latest`: un AppImage enlaza contra la glibc de la
  máquina que lo construyó, así que compilar en una imagen más nueva
  reduciría en silencio el rango de distros donde puede arrancar. La matriz ya
  tenía `fail-fast: false`, así que un fallo en la pata de Linux no puede
  tumbar los artefactos de Windows, y el paso de `tauri-action` ha ganado
  `retryAttempts: 3` porque ahora hay dos patas publicando artefactos del
  updater en una misma release: la action fusiona la entrada de cada plataforma
  en el `latest.json` existente en vez de reemplazar el asset, así que no se
  pierde ninguna entrada, pero dos patas en paralelo pueden competir al
  borrarlo — reintentar todo el ciclo descargar-fusionar-subir es la mitigación
  prevista por upstream. Todavía no se ha probado con un tag real — el
  `workflow_dispatch` del workflow construye un borrador contra un tag
  desechable justo para este tipo de comprobación.

### Cambiado

- **El nombre del entorno en el rail izquierdo es algo más grande.** Estaba a
  10px, que en una pantalla de 1080p se quedaba por debajo de lo que necesita el
  único trozo de interfaz de entornos que está siempre visible para leerse de
  reojo. Ahora son 11px con el espaciado entre letras más cerrado, así que sigue
  cabiendo aproximadamente el mismo número de caracteres en los 72px del rail
  antes de truncar, y el nombre del entorno activo va en peso medio — "en qué
  entorno estoy" se lee ahora también por la tipografía, no solo por el tinte
  del fondo.

### Corregido

- **El README mandaba a los usuarios de Windows a un `.msi` que ya no existe.**
  El empaquetado de Windows pasó de WiX/MSI a NSIS en la 1.7.0 (ver gotcha #21
  en `CLAUDE.md`: WiX v3 quedó archivado en febrero de 2025 y su `light.exe`
  dejó de ejecutarse en los runners de Windows de GitHub), así que las
  releases llevan varias versiones publicando un `-setup.exe` mientras tres
  sitios del README — la instrucción de descarga, el consejo del SHA-256 en la
  nota de SmartScreen y la línea de empaquetado del stack — seguían nombrando
  el MSI. Quien siguiera el README buscaba un archivo que no está adjunto a la
  release.

- **Plegar un grupo de conexiones en una pantalla lo plegaba silenciosamente en todas las demás donde estuviera visible a la vez.** `useConnectionGroupCollapse` (`src/lib/connection/useConnectionGroups.ts`) lo comparten el menú Archivo, el diálogo de gestión de conexiones, el selector de la barra de estado y el árbol de Esquema del entorno; en el modo por defecto "recordar" leía `prefs.ui.collapsedConnectionGroups` como un selector de Zustand en vivo, así que cada instancia montada se volvía a renderizar a partir del mismo valor en cada toggle. Abrir el diálogo de gestión de conexiones con el árbol de un entorno ya con un grupo abierto lo mostraba también abierto ahí (esperable — es la misma disposición recordada), pero plegar ese grupo _dentro del diálogo_ también lo plegaba en vivo en el árbol de detrás, porque ambas pantallas eran en realidad una única instancia compartida del estado de plegado, no vistas independientes que simplemente partían de la misma disposición guardada. El hook ahora siembra, al montarse, un override de sesión propio de cada instancia a partir del conjunto persistido, y cada toggle — en los tres modos, no solo en los forzados "expandido"/"plegado" — solo toca el estado local de esa instancia; los toggles en modo "recordar" siguen escribiéndose a disco, así que la _siguiente_ pantalla en montarse (incluido un futuro arranque de la app) recoge la disposición más reciente, pero una pantalla que ya está abierta en otro sitio deja de recolocarse sin que el usuario lo pida. No cambia ninguna preferencia ni el formato en disco.

- **El botón "Reiniciar ahora" no daba ningún feedback tras pulsarlo, lo que invitaba a pulsarlo varias veces.** `installAndRelaunch` (`src/stores/update.ts`) pasaba directamente de `readyToRestart` a un estado transitorio `ready` justo antes de `installUpdate()`/`relaunchApp()` — pero todo lo que ocurre en medio (una comprobación asíncrona del sidecar de MCP, y su diálogo de confirmación si algún cliente lo tiene abierto ahora mismo) se ejecutaba mientras el store seguía reportando `readyToRestart`, así que tanto `UpdateBanner` como la tarjeta de actualizaciones de Ajustes → Acerca de seguían mostrando la etiqueta inactiva "Reiniciar ahora" / "Instalar y reiniciar" con el botón totalmente pulsable. Ahora se fija un nuevo estado `installing` de forma síncrona en el instante en que se ejecuta el handler del click, antes de cualquier `await`; ambos componentes deshabilitan su botón de instalar (y en el banner también los controles de descarte) y muestran un spinner con la etiqueta "Reiniciando…" durante todo ese hueco. `installAndRelaunch` también corta en seco si se vuelve a invocar mientras ya está en `installing`/`ready`, así que una doble invocación accidental no puede encolar una segunda instalación aunque un click se cuele.

## [1.14.0] — 2026-08-13

### Añadido

- **La paleta de comandos (Ctrl/Cmd+K) ya es un lanzador de verdad.** Antes
  indexaba tres cosas — las conexiones guardadas, las tablas de la conexión
  seleccionada y un puñado fijo de acciones (nueva consulta, preferencias,
  tema, idioma) — filtradas con un `includes()` de subcadena. Ahora indexa
  trece grupos y los ordena por relevancia:
  - **Cada preferencia individual**, al estilo de VS Code: escribir `#ajuste`
    (o simplemente `wrap`) encuentra «Ajustar líneas largas», muestra su valor
    actual y Enter abre Preferencias en esa sección y baja hasta _esa fila_,
    resaltándola. Los ajustes booleanos además se pueden alternar sin salir de
    la paleta con Alt+Enter, que la deja abierta para que el valor se actualice
    bajo el cursor. Cada atajo reasignable se indexa igual, con su combinación
    actual.
  - **La documentación** (cada documento de la app, más Novedades,
    Informar/sugerir, Buscar actualizaciones, Acerca de y la página de MCP).
  - **Navegación**: pestañas abiertas (Enter salta, Alt+Enter cierra),
    conexiones guardadas (Alt+Enter desconecta una activa), entornos, las bases
    de datos de un servidor multi-base, tablas y vistas de _todas_ las
    conexiones abiertas y no solo de la seleccionada, consultas guardadas y las
    últimas 20 entradas del historial.
  - **Acciones** que solo existían en un menú: nueva conexión, gestionar
    conexiones, importar/exportar perfiles, desconectar todo, recargar el
    esquema, recargar los datos de la tabla activa, cerrar/fijar la pestaña
    activa, cerrar todas, nueva ventana, restablecer la disposición, flotar el
    panel activo y un interruptor por cada panel del dock.

  La búsqueda también cambió de forma: las entradas se puntúan en vez de
  filtrarse (`src/lib/commandPalette/fuzzy.ts` — prefijo gana a inicio de
  palabra, que gana a subcadena, que gana a subsecuencia, con bonus por
  densidad de coincidencias y límites de palabra, y desempate por longitud),
  los caracteres que coincidieron se resaltan en cada fila, los grupos se
  ordenan por su mejor coincidencia para que las cabeceras sigan teniendo
  sentido, y los comandos que de verdad usas suben al principio bajo el
  encabezado «Usados recientemente» (persistido en `localStorage`).

  Los prefijos de modo acotan la búsqueda como en VS Code — `>` acciones,
  `@` tablas, `#` ajustes, `?` ayuda, `:` ir a — mostrados como chips
  clicables mientras el campo está vacío y recorribles con Tab, para que una
  conexión con miles de tablas no sepulte las acciones.

- **`Ctrl/Cmd+Shift+P` abre la paleta en modo solo acciones** (paridad con
  VS Code). Reasignable como el resto, en Ajustes → Atajos.

- **La paleta puede indexar bajo demanda las tablas de un servidor
  multi-base.** Una conexión a todo el servidor arranca con solo la lista de
  _bases de datos_ cargada — las tablas de cada base llegan en su propio
  fragmento `<padre>::db::<nombre>`, y solo cuando algo abre esa vista — así que
  un servidor recién conectado ofrecía bases de datos y ninguna tabla que
  buscar. El modo `@` ahora incluye también una entrada «Indexar todas las bases
  de datos de X» mientras alguna siga sin indexar; al ejecutarla abre esas
  vistas de tres en tres y deja la paleta abierta para que las tablas aparezcan
  bajo el cursor. Es una acción deliberada y no un abanico automático en cada
  pulsación porque cada vista es otro pool de conexiones — el mismo
  razonamiento, y el mismo límite de concurrencia y cortacircuitos por límite de
  conexiones, que la búsqueda entre bases del explorador de esquema
  (`src/lib/commandPalette/warmSchema.ts`). Se respeta el subconjunto de «bases
  de datos a mostrar» de cada conexión, así que una base oculta en el árbol
  sigue oculta en la paleta.

- **Importar/exportar un tema desde Ajustes → Apariencia.** Un icono de
  exportar junto al selector de modo del editor de temas escribe el tema
  activo (integrado o personalizado) a un archivo JSON mediante el diálogo
  nativo de guardar; un icono de importar en la cabecera de la lista de temas
  lee uno de vuelta como un tema personalizado nuevo (siempre con un id
  nuevo, nunca choca con uno existente) y cambia a él de inmediato, igual que
  ya hace duplicar un tema. El formato del archivo es un pequeño envoltorio
  versionado (`src/lib/themeTransfer.ts`) — los temas viven enteramente en el
  almacén respaldado por `localStorage` del frontend, así que lo único que
  necesita el backend es un comando `write_text_file` estrecho, análogo al
  `read_text_file` que ya usa la importación de SQL.

- **Un tema integrado "Summer"** — una paleta clara y cálida (fondo de arena
  soleada, un único acento turquesa-océano para brand/ring, tonos coral en
  primary y destructive) que se suma a los temas integrados existentes en
  `src/lib/themes.ts`.

- **Tema por entorno.** El diálogo de crear/renombrar entorno
  (`EnvironmentEditorDialog`) incorpora un selector de tema junto al campo ya
  existente de color, listando todos los temas integrados y
  personalizados más una opción "Predeterminado". Asignar un tema a un
  entorno lo aplica automáticamente cada vez que se entra en él — al arrancar
  la app o al cambiar de entorno (`switchTo`) — y quitarlo (la opción
  predeterminada, siempre disponible) vuelve al tema que tengas configurado
  en Ajustes → Apariencia. La asignación se superpone al almacén de temas
  existente (`useThemeStore.setEnvironmentOverride`) en vez de sobrescribir
  el tema predeterminado persistido, así que volver a un entorno sin tema
  asignado nunca pisa la elección habitual del usuario. Se persiste en el
  backend como `Environment.themeId` (`tab_state.json` v4; `None` por
  defecto, así que los entornos existentes no se ven afectados).

- **Doble clic en el borde de una columna de la rejilla para ajustarla a su
  contenido** (el gesto de HeidiSQL). Un valor demasiado largo para el ancho
  por defecto —la configuración serializada de un widget, un párrafo de
  descripción— ya no obliga a abrir el editor de celda solo para leerlo: la
  columna crece hasta el valor más ancho que hay en pantalla y se queda así
  (se persiste por tabla, igual que un redimensionado manual). Con
  `Ctrl`/`Cmd` pulsado el doble clic ajusta todas las columnas de golpe, y el
  tooltip del tirador explica ambos gestos. La barra de herramientas de la
  rejilla incorpora además un botón para la versión "ajustar todas", para que
  no dependa de un gesto que hay que conocer — tanto en pestañas de tabla como
  en resultados de consulta. El ajuste se mide sobre el texto tal y como se
  _dibuja_ (se aplican el modo de visualización de BIT, el marcador de NULL y
  el tope de "truncar texto largo en") y se limita a 900 px, para que una columna ancha no eche el resto de la fila fuera de la
  pantalla; arrastrando a mano se sigue pudiendo ir tan ancho como se quiera.

- **La barra de herramientas de la rejilla es responsive.** En un panel
  estrecho se partía en dos filas, con el clúster de filtros en una y el de
  acciones en la otra. Ahora las acciones se salen de la barra: mide su propio
  ancho (vive en un panel del dock, así que una media query mediría lo que no
  toca) y colapsa en dos pasos — primero las acciones de datos con etiqueta
  (insertar, importar, exportar, actualizar en masa) pasan a un único menú
  `⋯`, y con el panel ya realmente estrecho lo hace todo lo demás, quedando
  solo el buscador y el `⋯`. Los chips de filtros activos se pliegan en un
  único chip "2 filtros" cuyo desplegable sigue quitándolos uno a uno, y el
  recuento de filas y el tiempo de consulta se van al menú en vez de
  desaparecer — salvo en una rejilla sin nada más que colapsar (un resultado de
  consulta ad-hoc), donde se quedan en la barra porque no habría menú donde
  leerlos.

- **La estructura exterior de la ventana ahora se organiza con una barra de
  actividad en vez de cinco paneles dockview de igual rango.** Esquema,
  Guardadas, Consola, el editor de celda y el espacio de trabajo vivían como
  grupos dockview intercambiables que se podían arrastrar, tabular juntos o
  flotar — lo que sugería visualmente que se podían crear más "espacios de
  trabajo", algo que nunca fue la intención. Consola ahora se ancla abajo
  con su propia cabecera colapsable; Guardadas se colapsa/expande desde un
  botón en una nueva barra de actividad derecha; el editor de celda es un
  simple split flexbox _dentro_ de la isla del espacio de trabajo en vez de
  un grupo dockview hermano (así que abrirlo o cerrarlo ya no puede disparar
  el efecto secundario de dockview de redistribuir proporcionalmente los
  paneles vecinos); y el propio espacio de trabajo es una tarjeta "isla" fija
  y no arrastrable con su propia cabecera, que envuelve sin cambios el área
  de pestañas de tabla/consulta abiertas. Cada panel ahora anima su apertura
  y cierre (200ms con suavizado, suspendido durante un arrastre activo del
  separador para que el redimensionado siga siguiendo el puntero 1:1) en vez
  de aparecer/desaparecer de golpe. Nuevos botones de mostrar/ocultar al
  estilo VS Code en la esquina superior derecha de la cabecera (iconos
  `PanelLeft`/`PanelBottom`/`PanelRight`) muestran u ocultan Esquema, Consola
  y Guardadas de forma independiente a las barras de actividad. El estado de
  la disposición se trasladó a un almacén pequeño
  (`stores/session/panelLayout.ts`, persistido por separado del antiguo blob
  de dockview) porque la API de paneles de dockview no tiene `setVisible`
  para un panel normal — no hay forma de colapsar uno a 0px sin eliminarlo,
  lo que redistribuye a sus vecinos. El dockview anidado dentro de la isla
  del espacio de trabajo (pestañas de tabla/consulta abiertas, su propia
  geometría de división/flotación, arrastrar y soltar) no se ve afectado en
  absoluto.

- **La barra de actividad izquierda ahora es una columna de entornos al
  estilo Discord/Teams** en vez de un único botón genérico "Esquema". Cada
  entorno tiene su propio avatar (iniciales sobre su color de acento, en un
  cuadrado redondeado — ver la siguiente entrada) con su nombre debajo; un
  "+" al final abre el mismo diálogo de creación que ya tenía el selector de
  la barra de estado. Al hacer clic en un entorno que no es el activo se
  cambia a él _y_ se abre el panel de Esquema en un solo gesto; al hacer clic
  en el ya activo simplemente se colapsa/expande Esquema — ya no hay un
  botón de alternancia dedicado aparte, porque sería redundante con este.
  Al hacer clic derecho sobre un avatar se abre el mismo menú de
  renombrar/eliminar que ya ofrecían las filas del desplegable del selector
  de la barra de estado, así que gestionar entornos ya no exige bajar hasta
  la barra de estado. El selector de la barra de estado (`EnvironmentSwitcher`)
  no cambia y sigue ahí — esto es una forma adicional de cambiar de entorno,
  no un reemplazo.

- **Los entornos se representan como un avatar de iniciales al estilo Teams**
  — hasta dos letras derivadas del nombre, sobre el color de acento del
  entorno (un gris neutro si no hay ninguno asignado), con el color del texto
  elegido automáticamente para mantener el contraste. Sustituye al antiguo
  selector de iconos de lucide en el diálogo de crear/renombrar entorno, que
  ha desaparecido; el diálogo ahora muestra una vista previa del avatar en
  vivo junto al campo de nombre. Se usa en todos los sitios donde se muestra
  un entorno: la nueva columna, las tarjetas del selector de entorno del
  espacio de trabajo vacío, y la vista previa del diálogo de crear/renombrar.
  El selector de la barra de estado mantiene deliberadamente un simple punto
  de color en su lugar — a esa escala las iniciales son demasiado pequeñas
  para leerse bien. `Environment.icon` no se lee pero se mantiene en el
  contrato de datos (tanto en el almacén del frontend como en la estructura
  `tab_state.json` del backend — no hizo falta ninguna migración) como el
  futuro hueco para una imagen personalizada subida por el usuario, que está
  pensada pero todavía no implementada: el componente del avatar está
  estructurado para que más adelante se pueda añadir una rama `<img>`
  respaldada por `env.icon`, con prioridad sobre las iniciales, sin tocar
  ningún punto donde ya se usa.

### Cambiado

- **Una pestaña del espacio de trabajo ya muestra el nombre de la tabla en
  lugar de quedarse sin sitio antes de llegar a él.** Con pestañas de varias
  conexiones abiertas, cada una imprimía `conexión · base · base.tabla` — la
  base de datos dos veces — y lo único que distingue una pestaña de otra, la
  tabla, era justo lo que se cortaba. La base aparece una sola vez, y la
  etiqueta se recorta por prioridad: el contexto de conexión (que se repite en
  todas las pestañas de esa conexión, y que el logo del driver ya señala) cede
  su ancho primero y el nombre conserva el suyo, separados por una línea fina
  en vez de otro `·` dentro de un nombre lleno de ellos. Al pasar el ratón por
  encima aparece la identidad completa — `esquema.tabla` cualificado y la
  conexión — con menos retardo que en un botón de la interfaz: en una pestaña
  recortada el tooltip es la única forma de leer el nombre entero.

- **Las pestañas recortadas se difuminan en vez de cortarse**, como en la tira
  de pestañas de un IDE: tanto un nombre demasiado largo para su pestaña como
  la pestaña que queda a caballo del borde de una tira con más pestañas de las
  que caben, que antes se cortaba a media letra contra una pared vertical.
  Cada difuminado aparece solo donde algo se corta de verdad: un nombre que
  cabe conserva su final, y una tira con sitio de sobra mantiene los bordes
  limpios. El borde difuminado sirve además de pista de que hay más pestañas
  en esa dirección.

- **El botón «∨» de la tira parece un botón**: superficie y borde propios
  sobre el fondo hundido de la tira. Ya no imprime el número de pestañas
  ocultas junto al galón — el galón ya significa «hay más», la propia lista
  enseña cuántas, y el número solo competía con los nombres de al lado.

- **El menú de pestañas desbordadas («∨ N») es la tira de pestañas puesta de
  canto.** Reutiliza el propio componente de cada pestaña oculta, así que cada
  fila llegaba con la geometría _horizontal_ de la tira: un margen de 7px por
  un solo lado y el ancho de recorte de la tira dentro de un desplegable con
  sitio de sobra, más dos barras de scroll, una de ellas horizontal. Los chips
  se quedan — mismo fondo hundido, mismo relleno y misma elevación, así que el
  desplegable se lee como parte de la misma superficie — pero ahora cada uno
  ocupa todo el ancho, con el nombre en una línea y su conexión debajo, el
  activo marcado con un raíl a la izquierda en vez de un borde superior, y el
  desplegable solo se desplaza en vertical.

- **Eliminado el botón «⊞ N» de la tira de pestañas.** Abría el selector modal
  a dos píxeles de la lista de desbordadas «∨ N», que responde a lo mismo sin
  salir de la barra. El diálogo sigue estando en `Ctrl`/`Cmd`+`P`
  (reasignable), que es lo único que busca por nombre entre todas las pestañas
  abiertas.

### Corregido

- **Saltar a una pestaña o tabla de una vista por base de datos dejaba el
  espacio de trabajo apuntando a otro sitio.** Una pestaña de un servidor
  multi-base lleva el id sintético `<padre>::db::<base>`, pero
  `useConnections.active` solo contiene ids de perfil de primer nivel
  (`markConnected` se ejecuta en `connect()`; una vista de base la abre
  `open_database_view`), y `App.tsx` limpia `selectedConnectionId` en cuanto no
  está en ese conjunto. Así que seleccionar un id hijo se deshacía un render
  después y se reemplazaba por el pool que llegara primero, de forma no
  determinista. Tanto el conmutador de pestañas (que ya lo tenía) como las
  nuevas entradas de tablas/pestañas de la paleta resuelven ahora el perfil
  propietario con `parentConnectionId`; la pestaña conserva el id hijo, que es
  lo que acota sus consultas.

- Un clic simple en el tirador de redimensionado de una columna ya no
  reescribe en `prefs.json` el ancho que esa columna ya tenía.

- Cerrar una pestaña desde la lista de desbordadas («∨ N») dejaba atrás una
  fila muerta, con el id interno de la pestaña donde estaba su nombre. dockview
  construye ese desplegable una sola vez, al abrirlo, y nunca lo reconstruye:
  ahora se cierra junto con la pestaña que se cerró desde él.

## [1.13.0] — 2026-08-12

### Añadido

- **Driver de Microsoft SQL Server** — el quinto motor, pedido por usuarios
  que usan HuginnDB contra SQL Server. Conectar (con soporte de túnel SSH),
  explorar bases de datos/esquemas/tablas/vistas/índices con recuento de filas
  y tamaños, ejecutar T-SQL en el editor, paginar/ordenar/filtrar la rejilla,
  editar celdas, insertar y borrar filas, actualización masiva, y el panel de
  usuarios/permisos. Las instancias nombradas (`HOST\SQLEXPRESS`) se resuelven
  a través del SQL Browser, y un interruptor de "confiar en el certificado del
  servidor" —activado por defecto— hace utilizables los certificados
  autofirmados que presentan la mayoría de instalaciones on-premise. En las
  compilaciones de Windows el diálogo de conexión ofrece además autenticación
  Windows (NTLM) con un `DOMINIO\usuario` explícito; el modo se oculta en el
  resto de plataformas porque el driver subyacente solo lo compila en Windows.
- El servidor mínimo soportado es **SQL Server 2012**: la paginación usa
  `OFFSET … ROWS FETCH NEXT … ROWS ONLY`, que no existe antes de esa versión.
- El motor nuevo entra en la contabilidad de conexiones descrita más abajo en
  vez de dimensionarse por su cuenta: `tiberius` no trae pool, así que el pool
  de sesiones propio de HuginnDB toma la misma asignación por servidor que
  cualquier otro driver, se cierra explícitamente al desconectar en lugar de
  esperar a que se libere solo, y suelta las sesiones que llevan cinco minutos
  sin usarse.
- **Ajustes → Conexiones** — una sección de preferencias nueva para el pool de
  conexiones: el techo de una conexión y el de una vista por base de datos,
  cuántas vistas por base de datos puede mantener abiertas una conexión,
  cuánto sobrevive una sin usar y el intervalo del keepalive. Muestra también,
  en vivo, cuántos pools está manteniendo HuginnDB, con un botón para liberar
  los de por base de datos. Esa visibilidad es la mitad del asunto: un
  `too many connections` solo es accionable si puedes ver tu propia
  aportación al problema.
- **Presupuesto de conexiones por servidor.** La unidad de contabilidad pasa a
  ser el servidor, no la conexión guardada. `Máximo de conexiones por
servidor` es toda la asignación que HuginnDB gastará contra un host,
  compartida por cada conexión y cada vista por base de datos que llegue a él
  — así que tres conexiones apuntando a la misma máquina PostgreSQL ya no
  reciben tres asignaciones independientes, que es exactamente cómo la huella
  llegó a no tener límite. Dos conexiones detrás de túneles SSH _distintos_
  que ambas dicen `localhost:5432` se tratan correctamente como servidores
  distintos; dos que conectan con usuarios distintos se tratan correctamente
  como el mismo, porque el límite del servidor es global.
  Cuando se agota la asignación de un servidor, abrir una vista de base de
  datos **cierra la vista que lleves más tiempo sin usar en ese mismo
  servidor** en vez de fallar — así explorar un servidor de doce bases de
  datos con un presupuesto de diez conexiones sigue funcionando. Si de verdad
  no hay nada que reclamar, el error nombra el presupuesto y dónde subirlo en
  lugar de soltar una cadena del driver.
- **Límite por conexión** — las conexiones tienen ahora un campo **Máximo de
  conexiones para este servidor**. La capacidad de conexión es un hecho del
  _servidor_, así que vive en la conexión: viaja con la exportación/
  importación de perfiles, se sincroniza por orígenes compartidos y el sidecar
  `huginndb-mcp` lo respeta automáticamente porque lee el mismo
  `profiles.json`. Vacío significa "usa la preferencia global".
- **`huginndb-mcp --max-connections <n>`** — techo del pool por conexión
  expuesta para el conector headless, con `2` por defecto. Ver la nueva
  sección "Connection footprint" en `docs/MCP.md`.
- **Compartir pools con el conector MCP** (Ajustes → Conexiones → _Compartir
  pools con el conector MCP_, desactivado por defecto). Con la opción
  activada, un sidecar `huginndb-mcp` en marcha deja de abrir sus propios
  pools y pide a la aplicación de escritorio que ejecute sus consultas. La
  máquina pasa entonces a tener **un presupuesto por servidor** por muchos
  clientes MCP que estén configurados — hasta ahora cada uno lanzaba su propio
  sidecar con sus propios pools, invisibles para la aplicación y entre sí. Dos
  consecuencias más que ya justifican el interruptor por sí solas: la
  actividad del conector aparece en la **Consola de la aplicación en vivo**,
  cada lectura y cada escritura según ocurren en vez de solo después en
  `mcp-audit.log`; y la aplicación vuelve a comprobar por su cuenta la
  política de escritura de cada conexión, con independencia de la comprobación
  del propio sidecar. El transporte es un listener solo de loopback con un
  token por ejecución guardado en un fichero `0600` junto a `profiles.json`.
  Cuando la aplicación no está en marcha, o la opción está desactivada, el
  conector se comporta exactamente igual que antes.
- `docs/CONNECTION_POOLING_ANALYSIS.md` — la auditoría de la que salen estos
  cambios: cómo asignaba conexiones el motor, la aritmética del peor caso, los
  hallazgos ordenados por gravedad y la arquitectura centrada en el servidor
  hacia la que apunta el trabajo restante.
- **Vista lista editable.** La vista de una tarjeta por fila deja de ser de
  solo lectura: ahora es un editor de documentos con la forma que hizo
  familiar MongoDB Compass. Los objetos y arrays anidados llegan **plegados** y
  se abren bajo demanda, cada campo es una línea numerada con su tipo en el
  margen derecho, y **hacer doble clic en un valor lo edita ahí mismo** (Enter
  o perder el foco confirma, Esc cancela, ∅ escribe NULL). El botón de
  expandir eleva el campo al mismo editor Monaco que usa la vista de tabla
  —modal o acoplado, siguiendo la preferencia `cellEditorMode` existente—, que
  es como se edita un subdocumento entero como JSON.
  En MongoDB el margen de tipos es un **selector**: elegir un tipo reescribe el
  campo como ese tipo BSON (el vocabulario completo de Compass — `Binary`,
  `UUID`, `Code`, `Timestamp`, `MinKey`/`MaxKey`, `BSONRegExp`, `BSONSymbol`,
  `Undefined` y los ya soportados), se pueden **añadir** campos (un `$set`
  sobre una ruta nueva, incluso dentro de un objeto anidado o añadido a un
  array) y **borrarlos** (un comando `unset_field` nuevo que emite `$unset`,
  detrás de la confirmación de acciones destructivas). El `_id` de un
  documento sigue siendo de solo lectura: un `$set` sobre él falla en el
  servidor, así que ofrecer la edición solo produciría un error.
  Editar un campo **anidado** lo direcciona por su ruta de actualización
  (`customData.format`, `tags.2`), de modo que un valor dentro de un
  subdocumento se escribe sin reescribir el documento que lo rodea.
- **Los resultados de MongoDB llevan ahora sus tipos BSON reales.**
  `QueryResult` gana un campo `row_types`: un árbol de tipos por celda que
  refleja la estructura del valor (`bson_type_tree`). El JSON de
  visualización es deliberadamente lossy — `Int32`, `Int64` y `Double` llegan
  todos como número JSON, y `ObjectId`, `Date` y `Decimal128` todos como
  cadena—, así que sin esto la vista lista habría tenido que adivinar el tipo
  a partir del valor y habría reescrito un `Long` como `Int` la primera vez
  que alguien corrigiera una errata en un campo sin relación. Los drivers SQL
  lo dejan sin poner; sus tipos de columna nunca fueron ambiguos.

### Cambiado

- **La vista lista funciona en todos los drivers.** Salió en la 1.11.0 como
  una representación exclusiva de MongoDB, pero el problema que resuelve —una
  fila ancha o anidada que se desplaza horizontalmente y aplasta sus valores
  anidados en una línea ilegible— no es exclusivo de MongoDB: una tabla de 40
  columnas, o una fila con una columna `jsonb` grande, tiene exactamente la
  misma forma. El interruptor de la barra de herramientas se ofrece ahora
  también en PostgreSQL/MySQL/SQLite, los valores son editables ahí por el
  mismo camino `update_cell` que la vista de tabla, y los valores anidados
  dentro de una columna JSON se pliegan como un subdocumento. Las tres
  acciones que solo tienen sentido en una base de datos documental —añadir
  campo, borrar campo, cambiar tipo— siguen ocultas en SQL, donde el conjunto
  de columnas de una fila pertenece a la tabla, no a la fila.
- **La preferencia de modo de vista se movió a Ajustes → Apariencia**, a un
  grupo nuevo **Vista de datos**, y perdió su redacción específica de MongoDB.
  Está junto al editor de temas porque responde a la misma pregunta ("qué
  aspecto tiene esto") en vez de a "cómo se comporta la rejilla", y ahora
  lleva tres opciones de la vista lista: si los valores anidados empiezan
  desplegados, si se muestra el margen de tipos y si los campos van numerados.
  La clave almacenada (`grid.documentViewMode`) no cambia, así que una
  elección existente sobrevive.
- **`connections.maxConnections` cambia de significado**: de "techo de un
  único pool" a "total para un servidor". No se publicó nada con el
  significado antiguo, así que no hace falta migración; el valor por defecto
  pasó de 5 a 10 en consecuencia, porque ahora cubre una conexión más sus
  vistas por base de datos en lugar de un solo pool. Una conexión de primer
  nivel pide como mucho 5 de esa asignación y deja sitio a propósito para una
  vista de base de datos, de modo que fijar un presupuesto ajustado en una
  conexión no puede volver imposible abrir sus propias bases de datos.

### Corregido

- **Una columna estrecha de la rejilla ya no esconde el nombre del campo en
  favor de su tipo.** La cabecera pone el nombre y el tipo de dato en una
  línea, y ambos eran elementos flex normales — pero solo el nombre podía
  encogerse, porque `truncate` es lo que permite a un elemento flex bajar de
  su ancho de contenido. Así que lo primero que tiraba una columna demasiado
  estrecha era justo la parte que la identifica: una columna `BOOLEAN` se
  quedaba en un escueto "BOOL", sin nada del nombre. Ahora la prioridad está
  invertida: primero se recorta el tipo, hasta desaparecer, y el nombre solo
  empieza a elidirse cuando ya no queda tipo.
- **El tooltip de la cabecera de columna describe el campo en vez de anunciar
  acciones de ordenación.** Ahora muestra el nombre completo (lo que recorta
  una columna estrecha), el tipo completo, la clave primaria/ajena con la
  `tabla.columna` referenciada, la nulabilidad cuando el catálogo la conoce y
  el estado de ordenación actual — y está traducido, cosa que nunca estuvo. El
  texto antiguo ofrecía "Ctrl/Cmd+clic para añadir una columna", que se leía
  como una oferta de _crear_ una columna: incorrecto, y alarmante en una
  ventana que además ejecuta DDL. La ordenación sigue siendo descubrible por
  la flecha de cada cabecera.
- **"Bases de datos a mostrar" ya no se filtra entre entornos.** El
  subconjunto se guardaba en la conexión, y una conexión es global: al
  restringir un servidor de pruebas compartido a la base de datos de un
  cliente desde un entorno de "Producción", también desaparecían el resto
  de bases en el entorno al que ese servidor pertenece de verdad. El
  selector ahora pregunta dónde se aplica la elección: **este entorno**
  (por defecto) la mantiene local, de modo que la misma conexión puede
  mostrar todas las réplicas en un entorno y una sola base en otro;
  **todos los entornos** la guarda en la conexión como hasta ahora, que es
  además el valor que viaja en la exportación/importación de perfiles y en
  los orígenes compartidos. Un entorno sin elección propia sigue a la de la
  conexión, así que nada cambia hasta que elijas otra cosa y los
  subconjuntos existentes siguen funcionando igual. Una conexión publicada
  por un origen compartido es de solo lectura, así que en ella solo se
  ofrece el ámbito local — antes no había forma de filtrar sus bases sin
  que la siguiente sincronización lo deshiciera. Las conexiones **no** se
  clonan por entorno a propósito: duplicaría credenciales y entradas del
  llavero y abriría un segundo pool contra el mismo servidor. Lo que se
  acota es la vista, no la conexión.
- **Los filtros del árbol de conexiones sobreviven con la reconexión
  automática desactivada.** Qué conexiones se muestran, qué filas están
  plegadas y los nuevos subconjuntos de bases por entorno se restauran al
  entrar en un entorno independientemente de la preferencia _Reconectar al
  arrancar_. Describen cómo se ve un entorno, no qué reabre; detrás de esa
  condición, entrar en un entorno con la reconexión desactivada dejaba en
  pantalla los filtros del entorno anterior.
- **`too many connections` en servidores compartidos.** La huella de
  conexiones de HuginnDB no tenía límite, era invisible y se multiplicaba
  entre procesos que no se coordinaban entre sí — lo que, en una base de datos
  que además servía a un origen de datos de JetBrains, al pool del backend de
  una aplicación y a uno o varios sidecars MCP, era con frecuencia la gota que
  colmaba el vaso. Había varias cosas mal a la vez:
  - Explorar un servidor multi-BD abría **un pool entero extra por base de
    datos**, cada uno con su propio techo independiente de cinco, y nada los
    cerraba nunca salvo desconectar la conexión padre. Un servidor con doce
    bases de datos eran ~65 conexiones de techo desde una sola ventana,
    mantenidas hasta cerrar la aplicación. Los pools por base de datos están
    ahora limitados a **2** conexiones, con un máximo de **8 vistas abiertas**
    por conexión (se cierra primero la que lleva más tiempo sin usarse) y se
    cierran automáticamente tras **5 minutos** sin uso. Se reabren de forma
    transparente al volver a usarlas, así que no se pierde nada salvo el
    viaje de ida y vuelta.
  - La búsqueda entre bases de datos del explorador de esquema lanzaba
    `openDatabaseView` contra **todas** las bases visibles a la vez — en un
    servidor de diecinueve bases, una sola pulsación eran diecinueve intentos
    de conexión simultáneos. Ahora ejecuta como mucho tres a la vez y vacía el
    resto como una cola.
  - El cliente de MongoDB no fijaba ningún límite de pool, heredando el valor
    por defecto del driver de **100 por host** — una divergencia de 20x
    respecto a los drivers SQL, por omisión. Ahora toma el mismo presupuesto
    que todo lo demás.
  - Los pools se desmontaban por `Drop` en vez de con un cierre esperado, así
    que una reconexión o un cambio de entorno podía mantener a la vez, de
    forma transitoria, la sesión saliente y la entrante. Desconectar (y
    cualquier otro camino de desmontaje) cierra ahora de forma ordenada, con
    un tiempo límite para que un servidor muerto no lo bloquee.
  - `min_connections` / `idle_timeout` / `max_lifetime` / `acquire_timeout`
    quedaban en los valores implícitos de `sqlx`. Ahora se fijan
    explícitamente, y el tiempo de inactividad se acortó a 5 minutos para que
    un pool sin tocar devuelva sus sockets.
  - "Probar conexión" abría un pool de cinco conexiones para ejecutar un solo
    `SELECT 1`. Ahora abre una, y la cierra.
- **El conector MCP nunca liberaba un pool** durante toda la vida de su
  proceso — que es lo que el cliente MCP lo mantenga, típicamente días. Ahora
  cierra los pools que lleven cinco minutos sin usarse y su techo por defecto
  es 2 en vez de heredar el 5 de la aplicación de escritorio.
- **`too many connections` se reconoce ahora como tal** en vez de aparecer
  como una cadena opaca del driver: Postgres `53300`/`53400`, MySQL
  `1040`/`1203`, el tiempo de espera del pool de MongoDB y el de adquisición
  de nuestro propio pool. El mensaje informa de cuántos pools está manteniendo
  el propio HuginnDB y señala que otros clientes de la máquina comparten el
  límite del servidor; la búsqueda en abanico se detiene en vez de volver a
  dispararse contra un servidor que ya la está rechazando, y ofrece liberar
  los pools inactivos y reintentar.
- **Editar una conexión reseteaba en silencio campos que el diálogo no
  muestra.** `save_profile` reemplaza el registro entero, y el diálogo lo
  reconstruía solo a partir del estado del formulario — así que guardar una
  conexión devolvía su política de escritura MCP a solo lectura y perdía su
  subconjunto de bases visibles. El diálogo conserva ahora los campos del
  perfil almacenado que no edita.
- El clasificador que aplica la política de escritura del conector MCP trataba
  dos sentencias T-SQL como lecturas: `SELECT … INTO <tabla>` (que crea una
  tabla) y `EXEC`/`EXECUTE` (que puede renombrar objetos o ejecutar DDL
  dinámico). Ahora ambas se clasifican como DDL, así que una conexión en nivel
  `read-only` o `data` las rechaza.
- La herramienta MCP `list_connections` derivaba el nombre del driver de una
  representación `Debug`, así que una conexión MongoDB se reportaba como
  `"mongo"` en lugar del `"mongodb"` que usa el resto de la aplicación.

### Limitaciones conocidas (SQL Server)

- El **editor de estructura es de solo lectura**: se muestran columnas, claves,
  índices y claves ajenas, pero aplicar cambios requiere un generador de DDL
  T-SQL que todavía no existe. Renombrar una tabla (`sp_rename`) y el **editor
  de vistas** no están disponibles por el mismo motivo.
- La **exportación/importación `.sql`** todavía no está disponible: necesita un
  codificador de literales T-SQL y gestión de `IDENTITY_INSERT`.
- No se ofrece autenticación integrada/SSPI (iniciar sesión con el usuario de
  Windows actual sin escribir credenciales) ni tokens de Entra ID.
- Una instancia nombrada no se puede combinar con un túnel SSH: el SQL Browser
  es un servicio UDP aparte que el túnel no reenvía. Tuneliza el puerto TCP
  propio de la instancia y deja el campo de instancia vacío.

## [1.12.1] — 2026-08-05

### Añadido

- **Actualización masiva** — actualiza todas las filas/documentos que
  coincidan con un filtro en una sola operación, para los cuatro drivers.
  Un nuevo botón "Actualización masiva…" en la barra de herramientas abre
  un diálogo que reutiliza el constructor de condiciones de filtro
  avanzado de la propia rejilla para la parte del `WHERE`, más un editor
  columna/campo → valor para la parte del `SET`; una previsualización con
  debounce muestra el `UPDATE ... SET ... WHERE ...` exacto (o el
  `db.<collection>.updateMany(...)` en MongoDB) y cuántas filas coinciden
  actualmente antes de ejecutar nada. Un filtro vacío se rechaza salvo
  confirmación explícita, para que una condición en blanco no pueda
  convertirse silenciosamente en una actualización de toda la tabla.
- **Los controles de exportación/importación se movieron a la barra de
  herramientas de la rejilla de datos.** La exportación/importación JSON
  por colección de MongoDB (antes solo accesible desde el menú de clic
  derecho del árbol de esquema) y sus nuevos equivalentes SQL viven ahora
  junto al botón "Insertar" de la rejilla: un desplegable "Exportar datos"
  ofrece "exportar toda la tabla/colección" o "exportar resultados de la
  consulta" (limitado al filtro avanzado actual de la rejilla, sin
  paginar); MongoDB añade además una entrada "Importar JSON…" en el mismo
  grupo. Una nueva fila inferior de la barra de herramientas aloja la
  paginación y el zoom de filas, separados de las acciones de datos de la
  cabecera.
- **"Exportar base de datos…" es ahora un diálogo propio**, accesible
  tanto desde el menú de clic derecho de una conexión (elige una o varias
  bases de datos y, por base de datos, qué tablas) como, en modo
  multi-BD, desde el menú de una base de datos concreta (fijado a esa
  única base de datos). Todo lo marcado se escribe en un único fichero
  `.sql` combinado, con un modo "Datos" que elige entre `INSERT`s planos o
  una forma de borrado-e-inserción que sobrevive a volver a ejecutar el
  volcado contra un destino que ya tiene datos. Sustituye a la antigua
  exportación de un clic, siempre de la base de datos completa.
- **"Importar .sql…" es ahora un diálogo de confirmación** en vez de un
  simple `confirm` nativo del navegador: muestra el número de sentencias
  por adelantado y, para una conexión multi-BD, permite elegir contra qué
  base de datos ejecutar el fichero (o ejecutarlo tal cual, para un
  fichero que ya referencia su propia base de datos vía `USE`/nombres
  cualificados).
- **Editor de estructura: selector de tipo categorizado.** El combo de
  tipo de columna ahora se agrupa por categoría (Enteros/Reales/
  Texto/Fecha y hora/Binario/Otro, un catálogo por driver) con un campo
  de longitud/precisión aparte, más las casillas unsigned/zerofill de
  MySQL — primera pasada de un rediseño más amplio, al estilo HeidiSQL,
  de la creación/edición de tablas.
- **Renombrar una tabla desde el editor de estructura** ahora funciona: el
  campo Nombre vuelve a ser editable en modo edición, y aplicar un
  renombrado actualiza el título de la pestaña abierta (y cualquier otra
  pestaña abierta de esa tabla) en vez de dejar mostrado el nombre
  antiguo. El diálogo de renombrado rápido del árbol de esquema recibió el
  mismo arreglo.

### Cambiado

- Las entradas de menú contextual "Exportar…"/"Importar…" por tabla
  (MongoDB) y por esquema (SQL) del árbol de esquema se eliminaron ahora
  que la barra de herramientas de la rejilla y los nuevos diálogos a
  nivel de conexión/base de datos cubren lo mismo — las entradas por
  esquema en particular estaban mal etiquetadas (exportaban la _base de
  datos completa_, no el esquema pulsado). La exportación/importación a
  nivel de conexión y de base de datos se mantienen en el árbol. El
  sufijo "(Beta)" de "Exportar base de datos…"/"Importar .sql…" ha
  desaparecido.
- La tabla de columnas del editor de estructura se rediseñó con el
  aspecto propio de la app (bordes y filas en cebra) en vez de una
  `<table>` desnuda de inputs planos, con un icono de llave marcando la
  clave primaria.
- Al arrastrar una pestaña de tabla/consulta para dividir el espacio de
  trabajo, ahora se distingue claramente entre "dividir en esta dirección"
  y "añadir como pestaña aquí" en vez de un único resaltado plano, y los
  paneles vecinos se ajustan a su nuevo tamaño con una transición suave en
  vez de saltar de golpe.

### Corregido

- El constructor de `ALTER` del editor de estructura (Postgres/MySQL/
  SQLite) nunca emitía un `RENAME TO` a nivel de tabla, aunque ya
  manejaba el renombrado de columnas; la ruta de reconstrucción
  destructiva de SQLite tenía el mismo bug especular en su fuente de
  `INSERT`/`DROP`. Ambos arreglados.
- El job de CI de `rustfmt` fallaba en todas las ejecuciones (no de forma
  intermitente) por una línea sin formatear que quedó de un commit
  anterior.

## [1.12.0] — 2026-08-03

### Añadido

- **Entornos** — un nuevo nivel por encima de las conexiones: un conjunto
  con nombre de conexiones con sus propias pestañas, disposición de
  paneles y reconexión, cambiable desde un selector en la barra superior
  (#109).
- **Orígenes compartidos** — sincroniza las conexiones (y contraseñas) de
  un entorno desde un fichero de configuración compartido, así que unirse
  a un equipo consiste en escribir una passphrase una vez en vez de
  configurar cada conexión a mano (#108).
- **Las conexiones viven ahora en el árbol de esquema**, como sus dos
  niveles superiores por encima de las carpetas; las acciones de una
  conexión se movieron a su menú de clic derecho (#107).
- **Un selector de espacio de trabajo** con pestañas y búsqueda
  (conexiones y entornos) sustituye al antiguo marcador de espacio vacío
  (#110).
- **Las pestañas de tabla recuerdan sus filtros, orden y búsqueda** al
  restaurar una sesión (#112).
- **Filtrar por las filas seleccionadas** — clic derecho sobre una columna
  con filas seleccionadas añade un filtro `IN`/`NOT IN` en servidor (#114).
- **Feedback de ejecución de consultas rediseñado**: un cronómetro en
  vivo, un reparto editor/resultados 75/25 por defecto y un historial con
  búsqueda y «ejecutar de nuevo» por entrada.
- **Neon**, un nuevo tema oscuro casi negro con una paleta de acentos neón
  propia.
- Las pestañas de tabla/consulta abiertas usan ahora el aspecto «isla» del
  resto de la app, con un distintivo de driver permanente por pestaña.
- Las columnas de la rejilla de datos ahora muestran un divisor visible, se
  dimensionan según su tipo (booleanos/números/fechas/UUID con un ancho
  sensato desde el principio) y se redimensionan con una previsualización
  en vivo real en vez de una guía estática.

### Cambiado

- «Ir al registro referenciado» pasa de Ctrl/Cmd+clic a Alt+clic,
  liberando ese acorde para la multiselección de filas (#113).
- La barra de estado global ya no duplica el contador de filas, el
  cronómetro ni el badge de solo lectura de la propia consulta.

### Corregido

- Varios errores al cambiar de entorno que podían perder las pestañas
  abiertas, el foco o la disposición dividida, o colapsar una división en
  un solo grupo de pestañas.
- Un `SELECT` precedido de un comentario se ejecutaba bien pero no
  mostraba filas.
- Ctrl/Cmd+clic ahora alterna la selección de filas de forma fiable,
  incluso en tablas sin clave primaria (#113).
- Los menús desplegables largos ahora hacen scroll en vez de recortarse
  (#111).
- Corregida la regresión de rendimiento en MySQL/Postgres de la
  separación del conteo de filas en la 1.11.0: el conteo ya no compite
  con la carga de datos por una conexión del pool.
- Los logos de driver y la muestra de tema ahora son sensibles al tema en
  vez de ir sobre una placa clara fija.

### Rendimiento

- Un clic en la rejilla de datos, y abrir una pestaña nueva junto a varias
  ya abiertas, dejaron de re-renderizar el resto de filas/pestañas — antes
  ambos escalaban con el total de filas/pestañas.

## [1.11.0] — 2026-07-24

### Añadido

- **Vista de lista para MongoDB.** Las pestañas de colección de una conexión
  `mongodb` ahora ofrecen un selector tabla/lista en la barra de
  herramientas (solo visible para ese driver — el resto siguen mostrándose
  siempre como tabla). El modo lista renderiza cada documento como una
  tarjeta con una línea `campo: valor` por columna de primer nivel en vez de
  una columna por campo, que era el problema real: un documento con muchos
  campos, o con un valor de objeto/array anidado, obligaba a hacer scroll
  horizontal constante en modo tabla y aplanaba el valor anidado en un JSON
  de una sola línea difícil de leer. El modo lista imprime los
  objetos/arrays anidados con sangría en vez de aplanarlos. Es
  deliberadamente de solo lectura en esta primera versión — sin edición
  inline de celdas, sin fila de borrador para insertar/duplicar —, ya que
  ambas necesitan la UI de fila editable de la tabla; "Copiar como JSON" y
  "Eliminar" por fila sí funcionan directamente desde la tarjeta, porque
  ninguna de las dos la necesita. El modo elegido es una preferencia global
  (`grid.documentViewMode` en `prefs.json`, también expuesta en Ajustes →
  Cuadrícula), no por colección — al mismo nivel que `rowHeight` o
  `bitDisplay` —, así que cambiarlo una vez aplica a todas las colecciones
  MongoDB que abras después.

- **Reconectar al iniciar.** Una nueva preferencia en General (activada por
  defecto) hace que la ventana principal se reconecte automáticamente, al
  arrancar, a las conexiones que estaban activas la última vez que se cerró
  — usando las credenciales ya guardadas en el llavero del sistema. Antes la
  app arrancaba desconectada y había que reconectar cada host a mano (y, por
  el bug de disposición descrito más abajo, en el _orden correcto_) para
  recuperar el espacio de trabajo. Las conexiones cuya contraseña no está
  guardada, o cuyo host es inalcanzable, se omiten sin bloquear el arranque;
  el interruptor permite desactivar la función por completo. El estado de
  arranque — qué conexiones estaban activas, cuál tenía el foco y qué
  pestaña estaba activa — se guarda al cerrar de forma ordenada y,
  oportunistamente, en cada conexión/desconexión, así que el espacio de
  trabajo vuelve tal como se dejó (misma conexión en foco, misma pestaña,
  misma disposición de paneles) sin importar el orden en que los pools se
  reabran, e incluso un cierre brusco deja algo que restaurar.

- **Canal de compilación canary.** Un nuevo canal de pre-lanzamiento opt-in
  permite dogfoodear un cambio contra perfiles de conexión reales de
  producción _antes_ de que se publique en un release estable — sin
  necesidad de un release completo. Una compilación canary (compilada con la
  nueva feature de Cargo `canary`, junto con
  `src-tauri/tauri.canary.conf.json`) se instala en paralelo con la app
  estable: tiene su propio identificador de bundle (`io.huginndb.canary`),
  nombre de producto ("HuginnDB Canary") y un feed de auto-actualización
  separado, y aísla todo su estado en disco en un directorio de
  configuración dedicado `HuginnDB-Canary`. Ese aislamiento permite que un
  canary ejecute con seguridad migraciones destructivas y de un solo sentido
  en disco sin tocar nunca `profiles.json` / `tab_state.json` / `prefs.json`
  de la instalación estable. El servicio de llavero del SO se comparte
  deliberadamente, así que el canary reutiliza las contraseñas que ya guardó
  la compilación estable en vez de forzar a reintroducirlas. Las
  compilaciones se generan mediante un workflow manual de GitHub Actions
  `canary` desde cualquier rama o commit y se publican en un único release
  `canary` rodante; ver `docs/CANARY.md`.

- **Indicador de sandbox para la compilación canary.** Como el canary
  comparte el bundle de UI (y el llavero del SO) con la app estable, una vez
  _dentro_ de la ventana las dos eran indistinguibles — fácil confundir el
  sandbox con la instalación real. La compilación canary ahora deja su
  identidad inconfundible: una cinta ámbar persistente "SANDBOX · HuginnDB
  Canary" fijada sobre la cabecera (mencionando el directorio de estado
  aislado), una insignia "CANARY" junto a la marca de la cabecera, un título
  de ventana del SO consciente del sabor de compilación ("HuginnDB Canary"
  en la barra de tareas / Alt-Tab, que el frontend antes sobrescribía de
  vuelta a "HuginnDB"), y un panel Acerca de que muestra el nombre de
  producto canary y sus rutas de estado reales `HuginnDB-Canary`. La
  compilación estable no cambia visualmente. Un nuevo comando
  `get_app_flavor` expone al frontend la feature de compilación `canary` en
  tiempo de compilación, ya que las dos compilaciones distribuyen un bundle
  JS idéntico.

### Cambiado

- **La disposición del panel de trabajo ahora es de nivel de sesión, no por
  conexión.** La geometría de división/flotación del dockview interno (cómo
  se organizan las pestañas de tabla/consulta abiertas) se guardaba antes de
  forma redundante bajo _cada_ conexión en `tab_state.json`, aunque un único
  dockview interno aloja las pestañas de todas las conexiones a la vez. Al
  restaurar, ganaba la conexión a la que te conectaras primero — así que la
  disposición solo volvía si te reconectabas en un orden concreto. Ahora se
  guarda una sola vez en el nivel superior de `tab_state.json` y se restaura
  una única vez al arrancar, independientemente del orden de conexión. Las
  disposiciones por conexión existentes se migran automáticamente en la
  primera carga tras actualizar (la usada más recientemente se promueve a la
  disposición de sesión), así que nadie pierde su distribución.

- **«Sacar a ventana flotante» ahora abre una ventana del sistema operativo
  real e independiente.** La acción de una pestaña llamaba antes a
  `addFloatingGroup` de dockview, que solo separa el panel _dentro_ de los
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

### Corregido

- **Hacer doble clic sobre el texto de una celda a veces ya no entraba en
  modo edición.** Desde que llegó el icono de «expandir» (#78), una celda
  seleccionada también dibuja un borde `ring-2 ring-inset ring-brand` sobre
  el propio `<td>`, ocupando el borde/padding de la celda junto al valor.
  En el webview de Linux (WebKitGTK), hacer doble clic directamente sobre el
  texto del valor a veces no llegaba a disparar el evento nativo `dblclick`
  — una peculiaridad conocida de WebKitGTK por la que `user-select: none`
  (fijado en toda la tabla, ver la nota `select-none` en `DataGrid.tsx`)
  suprime `dblclick` específicamente cuando hay texto seleccionable bajo el
  puntero, mientras que hacer doble clic sobre el padding vacío de la celda
  (sin ningún carácter bajo el cursor, que es lo que hacía parecer que el
  truco era clicar «el borde») funcionaba sin problema. El manejador
  `onClick` del `<td>` ahora también comprueba el propio `detail` del
  evento `click` (el contador nativo de clics del SO, al que esa
  peculiaridad no afecta): un segundo clic (`e.detail >= 2`) entra
  directamente por `openCellEdit`, la misma ruta que ya usaba
  `onDoubleClick` — así que el modo edición ahora se abre de forma fiable
  sin importar en qué punto exacto de la celda caiga el doble clic.

- **Escribir en una edición inline de celda ya no mandaba el cursor al
  final del valor en cada pulsación.** El `useMemo` de `columns` en
  `DataGrid` incluía `inlineEdit` (además de `fkEditCell`/`selectedCell`)
  en su array de dependencias, así que cada pulsación de tecla —que
  actualiza `inlineEdit.value`— reconstruía todo el array `columns`,
  entregando a cada columna una función `cell` con una referencia nueva.
  `flexRender` de TanStack trata `columnDef.cell` como un _tipo_ de
  componente (`typeof Comp === "function"` → `React.createElement(Comp,
props)`), así que una referencia nueva en cada render se interpreta como
  un tipo de elemento distinto para cada celda de la rejilla — forzando un
  desmontaje y remontaje completo de todo el cuerpo de la tabla, incluido
  el `<input>` que estuviera en edición. Un input `autoFocus` recién
  montado siempre coloca el cursor al final, que es exactamente lo que
  hacía imposible mover el cursor a mitad del valor y seguir escribiendo
  sin tener que reescribirlo entero. `fkEditCell`/`inlineEdit`/
  `selectedCell` ahora se reflejan en un `useRef` que se actualiza en cada
  render en lugar de ser dependencias del memo; la función `cell` de cada
  columna lee los valores en vivo desde esa ref, así que su propia
  identidad — y el DOM montado debajo — se mantiene estable entre
  pulsaciones.

- **Las ventanas secundarias («Nueva ventana») ahora pueden reorganizar sus
  paneles.** Arrastrar un panel en una ventana abierta desde el menú
  Ventana siempre mostraba el cursor de «no permitido»: la ventana se
  creaba sin el `dragDropEnabled: false` de la ventana principal, así que
  el gestor de arrastrar-soltar a nivel de SO de Tauri seguía activo y se
  quedaba con los eventos HTML5 drag de los que depende dockview. El
  constructor de la ventana secundaria ahora desactiva ese gestor nativo,
  igual que la ventana principal.

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
  secundario no deseado cuando el usuario solo quería _leer_ el valor. La
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
  _resuelto_ de `resolve_mongo_target` en vez del id de perfil real. En una
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
  (#64).** Una conexión multi-base listaba _todas_ las bases del servidor y
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
  _cada_ base justo tras conectar, así que una conexión con 19+ bases se quedaba
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
  _Duplicar_ que clona el perfil seleccionado en un borrador nuevo con el nombre
  uniquificado ("… (copia)"), listo para ajustar y guardar. La contraseña no se
  copia a propósito — las credenciales se indexan por id de perfil en el
  keychain del SO y el clon recibe un id nuevo — así que un aviso recuerda
  reintroducirla antes de conectar.
- **Modo de despliegue de grupos configurable (#40).** Una nueva preferencia en
  General (`Grupos de conexiones`) controla cómo aparecen los grupos de carpetas
  en el menú Archivo y en el gestor de conexiones — _siempre desplegados_,
  _siempre plegados_ o _recordar por grupo_ (el comportamiento anterior). Los
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
  registro _anterior_. Ahora Monaco se remonta con una pila de deshacer vacía en
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

## [1.6.0] — 2026-07-08

### Añadido

- **Interruptor legible de mostrar/ocultar en todos los campos de
  contraseña.** WebView2 dibuja un ojo nativo de revelar contraseña que no
  se puede tematizar y se renderiza casi negro — prácticamente invisible en
  superficies oscuras. Ahora está oculto en toda la app y sustituido por un
  interruptor `PasswordInput` tematizado (de apagado a color de primer
  plano al pasar el ratón, etiqueta bilingüe). Se aplica a todos los campos
  secretos: contraseña de conexión, contraseña/passphrase de SSH, las
  passphrases de exportación e importación, el prompt de contraseña al
  conectar y el token de GitHub del diálogo de feedback.

- **Renovación de la gestión de pestañas.** Con muchas pestañas abiertas era
  difícil saber qué tenías abierto o saltar a una tabla concreta. Cuatro
  novedades lo resuelven:
  - **Conmutador rápido de pestañas abiertas (Ctrl/Cmd+P).** Un overlay
    centrado en el teclado que lista las pestañas _actualmente abiertas_ en
    todas las conexiones, agrupadas primero las fijadas y luego por
    `conexión · base de datos`. Busca por nombre, navega con las flechas,
    Enter salta (y apunta el espacio de trabajo a la conexión de esa
    pestaña), y cada fila fija/desfija o cierra en línea (Suprimir cierra la
    resaltada). Distinto de la paleta de comandos (Ctrl+K), que abre cosas
    _nuevas_.
  - **Marcadores de tabla abierta en el árbol de esquema.** Toda tabla que
    está abierta en una pestaña muestra ahora un punto suave de marca en el
    árbol — no solo la activa — así que puedes ver de un vistazo qué tienes
    ya abierto mientras navegas.
  - **Botón conmutador en la barra de pestañas** con un contador en vivo de
    pestañas abiertas, que además sirve de acceso al desbordamiento cuando
    no caben todas.
  - **La pestaña activa siempre se desplaza a la vista.** Abrir una tabla
    cuando la barra ya estaba llena dejaba la nueva pestaña (activa)
    recortada detrás de los controles de desbordamiento ∨ / conmutador / "+"
    — dockview desplaza la pestaña activa a la vista, pero lo hace antes de
    que nuestro contenido de pestaña personalizado haya maquetado, así que
    la nueva pestaña quedaba oculta. La pestaña activa ahora se desplaza
    completamente a la vista en cuanto su contenido se pinta.
  - **Fijado + cierre masivo más completo.** Las pestañas se pueden fijar
    (⋮ / clic derecho, o desde el conmutador) para sobrevivir a «cerrar
    otras / todas / a la derecha»; las pestañas fijadas llevan un marcador
    de pin y se agrupan primero en el conmutador. Los menús de pestaña
    ganaron «Cerrar pestañas a la derecha» y «Cerrar otras en esta
    conexión». Los pines persisten por conexión entre reinicios.
- **Presentación de «Novedades» tras una actualización.** El primer arranque
  tras una actualización que sube la app a un release marcado `major` ahora
  muestra un diálogo curado e iconificado de puntos destacados (la
  contrapartida directa del changelog exhaustivo en Ajustes → Acerca de). El
  contenido es un catálogo empaquetado y redactado a mano en
  `src/lib/releaseNotes.ts` con copy bilingüe en i18n; el marcador de
  «visto» se persiste en `localStorage` (reflejando el store de
  actualizaciones) así que se dispara exactamente una vez por release
  `major`, solo en la ventana principal. Accesible en cualquier momento
  desde Ayuda → «Novedades». Al cortar un release `major`, añade su entrada
  (coincidiendo exactamente con la versión del manifiesto) y márcala como
  `major`.
- **Botón de ejecutar visible en el editor de consultas (renovación de
  UI/UX, fase 2).** La acción principal del editor no tenía ningún botón —
  era solo Ctrl+Enter y un CodeLens por sentencia, con un «Ejecutar todo»
  que aparecía condicionalmente. Un botón Ejecutar relleno con el color de
  marca ahora encabeza la barra de herramientas con un chip de atajo
  Ctrl/⌘+Enter, ejecuta todo el búfer (enrutando al ejecutor por lotes
  cuando contiene más de una sentencia) y muestra un spinner mientras se
  ejecuta. Guardar / historial quedan relegados detrás de un separador.
- **Rediseño del árbol de esquema (renovación de UI/UX, fase 1).** El árbol
  de base de datos/tabla de la izquierda ganó jerarquía y orientación claras.
  La tabla actualmente abierta se marca ahora en el árbol — un lavado suave
  de color de marca más un riel de marca de 2px con inset, controlado por la
  pestaña activa — así que siempre puedes ver «dónde estás». El nombre de la
  tabla es el elemento más destacado de su fila (primer plano / peso medio)
  frente a las etiquetas de sección y filas de columna, que son apagadas; los
  tipos de dato de columna están codificados por color (numérico ámbar /
  booleano verde / el resto apagado, reutilizando los tonos semánticos de la
  rejilla), y las columnas de una tabla cargan detrás de un esqueleto
  shimmer en vez de una línea en cursiva de «cargando…». La sangría de
  columnas sigue una escalera consistente de 12px por nivel (esquema →
  sección → tabla) con una línea continua de profundidad que baja desde el
  chevron de cada tabla abierta, y las insignias de métricas de tabla usan
  cifras tabulares. La confirmación de «base de datos creada» en modo
  single-database es ahora un toast tematizado en vez de un `alert()` nativo.
- **Navegación por teclado en la rejilla de datos (renovación de UI/UX, fase
  1).** La rejilla era solo de ratón, en contradicción con la identidad
  keyboard-first de la app. Las celdas ahora llevan una «celda activa»
  navegable por teclado marcada con un anillo `brand` con inset: las flechas
  la mueven, Inicio / Fin saltan a la primera / última columna de la fila,
  Enter abre el editor de celda (inline / combobox de FK / modal, mismo
  enrutado que el doble clic) y Escape la limpia. Hacer clic en una celda
  siembra la celda activa para que el teclado continúe desde ahí, y la celda
  activa se desplaza a la vista según se mueve (al instante — el indicador
  nunca anima, ya que sigue cada pulsación de tecla).
- **Casillas de selección de fila visibles en la rejilla de datos (renovación
  de UI/UX, fase 1).** La selección multi-fila ya funcionaba vía
  Ctrl/Cmd-clic y Mayús-clic, pero no había ninguna señal visible — el
  margen `#` solo mostraba el número de fila, así que la función era
  indescubrible. El margen ahora dibuja una casilla de seleccionar-todo de
  tres estados en la cabecera (marcada / indeterminada / vacía sobre las
  filas visibles) y una casilla por fila que aparece al pasar el ratón por
  la fila y se mantiene mientras la fila está seleccionada. Ambas se apoyan
  en el conjunto de selección existente indexado por PK (sobrevive a
  ordenar / filtrar / recargar) y se tiñen con el token `brand`; los números
  de fila ahora usan `tabular-nums`.
- **Exportar e importar bases de datos completas (#34), marcado Beta.** No
  había forma de sacar una base de datos de HuginnDB (o volver a meterla)
  salvo escribiendo un script a mano. «Exportar base de datos…» (menú
  contextual del explorador multi-base, o un botón de barra de herramientas
  en una conexión single-DB) vuelca esquema + datos a un único fichero `.sql`
  portable para Postgres, MySQL o SQLite. Postgres/MySQL escriben en tres
  fases — `CREATE TABLE` a secas, luego todos los datos, luego
  `ALTER TABLE ADD CONSTRAINT` (FK) + `CREATE INDEX` — así que un volcado de
  base de datos completa nunca necesita un orden topológico de dependencias
  entre tablas ni privilegios elevados (por ejemplo, el
  `session_replication_role` de Postgres, solo para superusuario). SQLite en
  cambio vuelca su catálogo tal cual desde `sqlite_master` (más fiel que
  reconstruir el DDL — conserva las restricciones `CHECK`, etc.) entre
  `PRAGMA foreign_keys=OFF/ON`. «Importar .sql…» elige un fichero y lo
  ejecuta a través del ejecutor de lotes de consultas _ya existente_ (la
  misma ruta `splitSql` + `execute_batch` que ya usa el editor de consultas)
  en vez de una segunda vía de ejecución, protegido tras la confirmación de
  acción destructiva. Marcado Beta en la UI — verificado hasta ahora solo
  por comprobación de tipos y `cargo check`, aún no probado de extremo a
  extremo contra un servidor real en los tres drivers.
- **Color de pestaña libre, y un estilo de acento seleccionable (#35).** El
  selector de color de pestaña solo ofrecía seis muestras fijas; ahora hay
  también un input de color nativo junto a ellas para cualquier valor hex.
  Por separado, el acento de la pestaña activa / color personalizado estaba
  fijado a una franja superior de 2px — una nueva preferencia en Ajustes →
  Rejilla → «Estilo de acento de pestaña» (`cap` / `rail` / `boxed`) lo
  cambia en su lugar a un riel izquierdo o un aspecto de superficie elevada,
  y un color de pestaña personalizado ahora sigue el borde que use el estilo
  elegido en vez de dibujarse siempre encima.

### Cambiado

- **Tooltips tematizados (renovación de UI/UX, fase 3).** Se añadió un
  wrapper de conveniencia `SimpleTooltip` sobre el primitivo Tooltip
  tematizado y se migró el chrome de la app fuera del `title=""` nativo para
  que sus tooltips combinen con el tema de la app en vez del predeterminado
  del SO: los botones de la cabecera (cambio de tema, preferencias), todas
  las señales de la barra de estado (paleta de comandos, historial de
  consultas, conmutadores de densidad y tema, el conmutador de conexiones) y
  las pestañas del espacio de trabajo (etiqueta, acciones ⋮, cerrar, nueva
  consulta +). Los disparadores de menú/contexto se envuelven en el propio
  trigger para que el tooltip se dispare al pasar el ratón mientras el menú
  sigue abriéndose al clic. El único caso que se deja deliberadamente en
  `title=""` nativo es un tooltip que vive _dentro_ de contenido de menú
  abierto (el reconectar/desconectar de las filas de conexión, las muestras
  de color de pestaña): un tooltip de Radix ahí choca con el propio manejo
  de hover/portal del menú, y un tooltip nativo del SO no lo hace.
- **Estado de conexión más claro (renovación de UI/UX, fase 3).** Una
  conexión perdida — posiblemente la señal operativa más importante — era
  un punto rojo de 6px más un icono rojo críptico. Las filas perdidas en el
  conmutador de conexiones de la barra de estado ahora reciben un lavado de
  fila destructivo y un botón «Reconectar» explícito y con etiqueta; los
  puntos indicadores de en-vivo/perdida son un poco más grandes, los
  botones de acción de fila tienen un área de clic real, y un intento de
  conexión fallido muestra un toast en vez de un `alert()` nativo. Las
  estadísticas de la barra de estado (número de filas, tiempo transcurrido,
  selección) suben sus números al primer plano con cifras tabulares.
- **Acciones de pestaña accesibles + peso de la pestaña activa (renovación
  de UI/UX, fase 3).** Los botones de cerrar (×) y acciones (⋮) de las
  pestañas del espacio de trabajo solo se revelaban al pasar el ratón,
  dejándolos inalcanzables por teclado; ahora también aparecen con el foco
  de teclado (focus-within / focus-visible). La etiqueta de la pestaña
  activa gana peso medio para combinar con la franja superior de marca +
  superficie elevada que ya lleva.
- **Marco de diálogo distintivo (renovación de UI/UX, fase 3).** Todo
  diálogo llevaba una `shadow-lg` plana con una entrada de solo fundido y un
  glifo de cerrar pelado y de baja opacidad. `DialogContent` ahora escala
  desde el centro (zoom, el movimiento correcto para un modal centrado),
  usa la escala de elevación compartida (`shadow-elevation-4`), y su botón
  de cerrar es un control con padding real y fondo al pasar el ratón en vez
  de una X sin área de clic al 70% de opacidad.
- **Control segmentado compartido + limpieza de consola/estructura
  (renovación de UI/UX, fase 2).** Un nuevo primitivo `Segmented` (radiogroup
  navegable por teclado con estilo de una sola tira de píldora con el
  segmento activo elevado) sustituye a las variantes hechas a mano: el
  conmutador de bug/feature del diálogo de feedback (dos botones completos) y
  las pestañas de sección del editor de estructura (botones planos sin
  ningún lenguaje de pestaña activa). El filtro de log de la consola ahora
  usa el `Input` compartido (tamaño pequeño) en vez de una caja de búsqueda
  hecha a mano, y sus casillas de tipo se tiñen con `accent-brand`.
- **Encuadre insignia del CellEditor (renovación de UI/UX, fase 2).** El
  editor de celda Monaco — la «función estrella» de la app — parecía un
  diálogo genérico. Ahora tiene un riel de cabecera con título: el nombre de
  columna, una insignia de tipo de contenido teñida con `brand`
  (JSON/XML/SQL/TEXT) y píldoras de recuento de caracteres/bytes, con los
  controles de panel/pantalla completa agrupados a la derecha. Ctrl/⌘+S y
  Ctrl/⌘+Enter guardan desde dentro del editor (vinculados vía Monaco para
  que no se traguen) con el atajo mostrado en el pie, la insignia de
  validez JSON es ahora un chip compacto con el mensaje del parser en su
  tooltip en vez de volcado en línea, y el frágil hack `mr-8` para esquivar
  el botón de cerrar se sustituye por padding de cabecera reservado.
- **Pulido de la paleta de comandos (renovación de UI/UX, fase 2).** La
  superficie insignia keyboard-first ganó las señales que le faltaban: una
  leyenda de pie persistente (↑↓ navegar · ↵ ejecutar · esc cerrar), un ↵ al
  final de la fila activa, un acento de borde izquierdo `brand` + icono
  teñido de marca en la fila activa, contadores de grupo en las cabeceras de
  sección, y un estado vacío iconificado. La fila resaltada ahora se
  desplaza a la vista durante la navegación con flechas (antes podía salirse
  de la pantalla), y un intento de conexión fallido muestra un toast en vez
  de un `alert()` nativo.
- **Chrome unificado del navegador de tablas (renovación de UI/UX, fase 1).**
  Una pestaña de tabla apilaba antes dos barras de herramientas casi
  idénticas. El breadcrumb de la barra superior (esquema › tabla) y el
  refrescar ahora se pliegan en la propia barra de herramientas de la
  rejilla de datos para que haya una sola barra, y la paginación + el zoom
  de fila pasan a una franja de estado de pie con cifras tabulares. La
  primera carga de una tabla muestra un esqueleto shimmer (con el
  breadcrumb) en vez de una línea pelada de «cargando…», y una recarga
  atenúa las filas obsoletas detrás de un spinner en vez de parecer
  congelada. El botón de confirmación de borrar fila ahora usa el estilo
  destructivo (rojo), igual que el diálogo de eliminar tabla.
- **Pulido de legibilidad de la rejilla de datos (renovación de UI/UX, fase
  1).** Las cabeceras de columna ahora muestran un glifo de orden
  persistente que se ilumina al pasar el ratón (era un icono casi invisible
  al 30% de opacidad), y toda la celda de cabecera gana un fondo al pasar
  el ratón para que la posibilidad de ordenar sea descubrible; el indicador
  de orden activo está alineado a la derecha y teñido con `brand`. Las
  lecturas numéricas — el número de filas, el rango de paginación y el
  tiempo transcurrido de la consulta — usan cifras tabulares para que dejen
  de cambiar de ancho al variar, los recuentos de fila/total se enfatizan
  en primer plano, y el tiempo transcurrido se vuelve ámbar y luego rojo
  solo cuando una consulta es lenta.
- **Acentos semánticos de dato tokenizados (`--pk` / `--fk` /
  `--numeric`).** Los iconos de llave de clave primaria/foránea y los
  valores numéricos de celda estaban fijados a `amber-400` / `sky-400` en
  la rejilla y el árbol de esquema, ignorando el tema activo. Ahora son
  tokens de tema (curados por cada tema integrado; más oscuros en temas
  claros para que los numéricos sigan siendo legibles en blanco) aplicados
  en DataGrid y SchemaExplorer. Se dejan fuera del editor de color de
  Apariencia por ser acentos de sistema de nicho.
- **Fundamento del sistema de diseño (renovación de UI/UX, fase 0).**
  Primera pasada de un rediseño de interfaz más amplio hacia un aspecto de
  herramienta de desarrollo moderna y densa. Sin funciones nuevas — esto es
  la base sobre la que se construye el resto de la renovación:
  - Dos nuevos tokens semánticos de tema, `--success` y `--warning`,
    distintos de `brand` (el único acento «en vivo / haz esto» de la app) y
    `destructive` (errores). Cada tema integrado fija sus propios valores
    curados y ambos son editables en Ajustes → Apariencia como cualquier
    otro color. Esto sustituye a los literales fijos `emerald-*` /
    `amber-*` / `blue-500` / `red-500` que estaban esparcidos por ~12
    componentes e ignoraban por completo el tema activo — así que los temas
    personalizados ahora recolorean las señales de estado de conexión,
    válido/inválido, advertencia y error. `applyTheme` también limpia
    cualquier token que un tema personalizado (preexistente) no defina, para
    que se aplique el valor por defecto de la hoja de estilos en vez de
    dejar un valor inline obsoleto del tema anteriormente activo.
  - Se unificó el indicador de «esta conexión está viva» en el token
    `brand`; antes se renderizaba esmeralda en el menú Archivo pero brand en
    el conmutador de la barra de estado para el mismo estado exacto.
  - Se añadió una escala de elevación (`shadow-elevation-1…4`, basada en
    `--foreground` para que se lea bien tanto en temas claros como oscuros)
    y una escala de micro-tipografía tokenizada (`text-2xs` / `text-3xs`,
    con un suelo de legibilidad de 10px) para sustituir los valores ad-hoc
    `text-[9px/10px/11px]`.
  - Anillo de foco de teclado más fuerte y consistente (`ring-2` + offset)
    en botones, inputs y selects, sustituyendo el anillo a ras casi invisible
    de 1px.
  - Las etiquetas de campo de formulario ahora usan por defecto
    `text-foreground` en vez de gris apagado, dando a todo diálogo una
    jerarquía real de etiqueta/valor.
  - `Input` ganó variantes de densidad (`inputSize` default/sm/xs) y un
    nuevo primitivo compartido `Textarea` sustituye a los campos multilínea
    hechos a mano en los diálogos de feedback y guardar consulta.
  - Se definió una pila de fuente sans-serif real para la UI (Inter primero,
    cayendo a la fuente de UI de la plataforma) en vez de depender del
    predeterminado pelado del sistema.

### Corregido

- **Los nombres de tabla largos ya no fuerzan scroll horizontal en el árbol
  de esquema (#33).** La etiqueta de nombre de tabla tenía `truncate` pero,
  como hijo flex sin `min-w-0`, nunca llegaba a encogerse por debajo del
  ancho de su contenido (los elementos flex por defecto tienen
  `min-width: auto`) — así que un nombre largo empujaba fuera la insignia
  de recuento de filas/tamaño y el árbol hacía scroll horizontal en vez de
  usar puntos suspensivos.
- **El menú de clic derecho de la pestaña ahora coincide con su menú ⋮
  (#36).** Los dos se mantenían a mano por separado y habían divergido: el
  clic derecho no tenía Dividir a la derecha/abajo, Flotar panel, ni las
  muestras de color que el menú ⋮ ya tenía. Ambos muestran ahora las mismas
  acciones en el mismo orden.

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
  las preferencias, ya que cada guardado envía el blob _entero_ (no un
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

## [1.3.0] — 2026-07-01

### Añadido

- **Alternativa «No tengo cuenta de GitHub» en el reportador de
  incidencias.** Las dos rutas existentes (creación por API con un PAT
  guardado, o la página del navegador `issues/new` precargada sin uno)
  siguen aterrizando en GitHub, lo cual es un callejón sin salida para un
  usuario sin cuenta — la página del navegador solo muestra un muro de
  login. Un nuevo enlace en el pie del diálogo construye en su lugar una
  URL `mailto:` (con el mismo asunto y cuerpo prefijados por título/tipo,
  incluyendo el bloque de diagnóstico si está activado) y la abre mediante
  el plugin `opener`, delegando el envío en la app de correo por defecto
  del usuario — HuginnDB nunca toca SMTP ni guarda una credencial de envío
  de correo. La codificación por porcentaje está hecha a mano (el conjunto
  "unreserved" de RFC 3986) en vez de reutilizar `query_pairs_mut` de
  `url`, que es `application/x-www-form-urlencoded` y convertiría los
  espacios en caracteres `+` literales en el cuerpo — técnicamente
  inválido en una consulta `mailto:` y que varios clientes de correo
  muestran tal cual. El destinatario es la dirección `contact@shion.es`
  del proyecto, mantenida separada de los hermanos de GitHub de la ruta
  mailto para que un reporte perdido no se confunda con una divulgación de
  seguridad. Requiere ampliar la capacidad `opener:allow-open-url`, antes
  limitada solo a `github.com`, para permitir también `mailto:*`.

- **«Ir a la fila referenciada» en celdas de clave foránea (al estilo
  IDE).** En el navegador de datos, **Ctrl/Cmd+clic** sobre una celda cuya
  columna es una clave foránea de una sola columna ahora salta
  directamente al registro maestro referenciado — abriendo (o enfocando)
  la tabla padre pre-filtrada a ese valor, igual que «ir a la definición»
  en un editor. La misma acción está disponible desde el menú contextual
  de clic derecho de la celda («Ir a la fila referenciada»), y las celdas
  navegables por FK ganan un sutil subrayado al pasar el ratón. Reutiliza
  los metadatos de FK que ya devuelve `list_columns` (`referenced_schema`
  / `referenced_table` / `referenced_column`) — ninguna consulta nueva al
  backend. La tabla destino recibe el filtro a través de un nuevo
  `initialFilters` transitorio en la pestaña; volver a navegar a una tabla
  ya abierta lo vuelve a aplicar en vez de no hacer nada en silencio.
- **«Nueva consulta aquí» sobre una base de datos (explorador
  multi-base).** Hacer clic derecho sobre un nodo de base de datos en el
  explorador multi-base ahora ofrece _Nueva consulta aquí_, abriendo una
  pestaña de consulta ya limitada a esa base. Se ejecuta contra la misma
  conexión sintética por base de datos que usa el explorador, así que la
  consulta apunta a la base en la que se hizo clic sin tener antes que
  expandirla ni cambiar el ámbito activo.

### Corregido

- **El reportador de incidencias integrado ahora sí abre el navegador.**
  Enviar un reporte (o seguir el enlace «ver incidencia») dependía de
  `window.open`, que es un no-op dentro del WebView de Tauri — al hacer
  clic no pasaba nada. Abrir URLs ahora pasa por el plugin
  `tauri-plugin-opener` y aterriza en el navegador por defecto del
  sistema. La nueva capacidad está limitada a `github.com`, el único host
  al que enlaza el reportador. Añade la dependencia `tauri-plugin-opener`.
- **Un `INSERT`/`UPDATE` escrito a mano con valores `BIT`/enteros ya no da
  error en MySQL.** Las sentencias ad-hoc del editor SQL se enviaban por
  el protocolo preparado (binario), que rechaza o maneja mal una familia
  de sentencias que un cliente CLI ejecuta sin problema — los recurrentes
  errores de literal `BIT`/entero. El editor no vincula parámetros, así
  que no hay nada que preparar: las sentencias que no son `SELECT` ahora
  pasan por el protocolo de consulta simple **sin preparar**
  (`sqlx::raw_sql`) tanto en la ruta de sentencia única como en la de
  lote, así que lo que escribes se parsea exactamente igual que lo haría
  el propio cliente del servidor. La decodificación de `SELECT` no
  cambia.

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
- **Reporte de incidencias integrado.** Una nueva entrada _Reportar / sugerir_
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
- **`authSource` para MongoDB.** Un campo dedicado _Auth source_ (p.ej. `admin`)
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
  _"Cannot read properties of null (reading 'toFixed')"_ — tumbando todo el
  panel. Esto afectaba a las conexiones CLI/ad-hoc y a builds de SQLite sin
  `dbstat`, y aparecía al filtrar porque el filtro fuerza la expansión de todas
  las secciones (renderizando badges que antes estaban colapsados). El backend
  omite ahora las estadísticas ausentes (acorde al contrato `?: number` del
  frontend) y el badge se protege con `!= null`; `formatBytes`/`formatCount`
  además abortan ante entradas no finitas.
- **Abrir o cerrar el editor de celda lateral ya no reinicia la división Esquema /
  Espacio de trabajo.** El editor lateral se acopla como hermano en la fila
  `[Esquema | Espacio de trabajo | Celda]`, y dockview redistribuye el espacio
  liberado/ocupado proporcionalmente entre _todos_ los hermanos cuando se añade o
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
  compatibilidad de tipo _antes_ de mirar los bytes, así que el valor caía a hex
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
  persistía _su_ valor obsoleto (pre-edición), así que las ediciones del panel
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

- **El túnel SSH se rompía cuando el puerto local configurado ya estaba en
  uso.** Si otro proceso (por ejemplo, un segundo túnel abierto a mano por
  el usuario) ocupaba el `local_port` fijado, el bind fallaba con
  `AddrInUse` y la conexión daba error. El túnel ahora recurre a un puerto
  efímero asignado por el SO y sigue funcionando; el pool sigue el puerto
  realmente vinculado y el perfil guardado se deja intacto.

- **Los campos del formulario de túnel SSH desbordaban el diálogo.** Al
  reconfigurar un túnel existente, los valores largos (en especial la ruta
  de la clave privada) empujaban los inputs y el botón "Examinar" fuera del
  borde del diálogo. Se añadieron restricciones `min-w-0`/`flex-1`/`shrink-0`
  para que los campos se encojan dentro del diálogo en vez de desbordarse.

- **Escritura de columnas `BIT` de MySQL — ruta `insert_row`.** `RowValue`
  ahora lleva un campo opcional `column_type`. Cuando el frontend construye
  el payload de INSERT de la fila borrador, rellena `columnType` a partir de
  `result.columns`, y el backend construye placeholders
  `CAST(? AS UNSIGNED)` para cada columna `BIT` de MySQL en vez de un `?`
  plano. Antes, vincular una cadena como `"1"` a una columna `BIT`
  guardaba el byte ASCII `0x31` (49) en vez del entero 1 — para columnas
  `BIT(n)` anchas esto escribía silenciosamente el valor incorrecto cada
  vez.

- **Escritura de columnas `BIT` de MySQL — ruta `update_cell`.** Se añadió
  un preprocesado `normalize_bit_value` para que la cadena entregada a
  `CAST(? AS UNSIGNED)` sea siempre una cadena de dígitos. Sin esto, si el
  editor de celda producía `"true"` o `"false"` (por ejemplo, tras escribir
  esas palabras en el editor Monaco), MySQL evaluaba
  `CAST('true' AS UNSIGNED)` como 0 sin importar el valor de bit
  pretendido.

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

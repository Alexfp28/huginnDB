# Registro de cambios

Todos los cambios relevantes de HuginnDB se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y el proyecto se adhiere a [Versionado Semántico](https://semver.org/lang/es/) a partir de la `1.0`.

> Nota: este archivo es la traducción al español de `CHANGELOG.md`. Cubre las versiones recientes; las versiones más antiguas se muestran en inglés dentro de la app hasta que se traduzcan.

## [Unreleased]

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

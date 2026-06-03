# Registro de cambios

Todos los cambios relevantes de HuginnDB se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y el proyecto se adhiere a [Versionado Semántico](https://semver.org/lang/es/) a partir de la `1.0`.

> Nota: este archivo es la traducción al español de `CHANGELOG.md`. Cubre las versiones recientes; las versiones más antiguas se muestran en inglés dentro de la app hasta que se traduzcan.

## [Unreleased]

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

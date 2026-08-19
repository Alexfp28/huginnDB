# MongoDB

> Nota: este archivo es la traducción al español de `MONGODB.md`. Si ves algo
> desactualizado respecto al original en inglés, ese es el que manda.

MongoDB es un driver de primera clase, no un añadido: el mismo explorador, la
misma tabla, las mismas pestañas y el mismo conector MCP le sirven. Pero es el
único motor sin SQL, así que varias superficies funcionan distinto y algunas —
las que solo tienen sentido con SQL — no existen ahí. Esta página es lo que
cambia.

## Conectar

El diálogo de conexión es por campos (host, puerto, base de datos, usuario,
**Origen de autenticación**) y construye la URI `mongodb://` en vivo con lo que
escribes. La contraseña se guarda en el llavero del sistema y *no* se incrusta en
la URI.

**Editar cadena de conexión** desbloquea la URI para lo que el formulario no
puede expresar: Atlas (`mongodb+srv://…`), replica sets y cualquier opción extra
de la URI. En cuanto la editas a mano, esa cadena es la que se usa tal cual — los
campos sueltos pasan a ser comodidades de mejor esfuerzo.

Dos límites que conviene saber de entrada:

- **El túnel SSH funciona con `mongodb://host:puerto`, no con
  `mongodb+srv://`.** Un registro SRV resuelve a varios hosts del replica set y
  un túnel solo puede dar frente a uno.
- Dejar la base de datos en blanco es válido: la conexión se abre a nivel de
  clúster y el explorador lista las bases. Las colecciones cuelgan del nodo de
  cada base de datos.

## Explorar

Bases de datos → colecciones → campos e índices, el mismo árbol que en el resto.
La lista de campos se **infiere** de una muestra de documentos, porque una
colección no tiene esquema declarado; es una ayuda de lectura, no un contrato, y
un campo que solo tienen algunos documentos también se muestra.

Los tamaños de colección y el tamaño/uso de los índices vienen de `$collStats` y
`$indexStats` y son de **mejor esfuerzo**: si tu rol no tiene el privilegio, la
columna desaparece en lugar de mostrar ceros que se leerían como «sin uso».

## El editor de consultas habla `mongosh`, en un dialecto acotado

El editor acepta sintaxis de shell, no SQL:

```js
db.orders.find({ status: "open", total: { $gt: 100 } }).sort({ createdAt: -1 }).limit(50)
```

- **Métodos**: `find`, `findOne`, `aggregate`, `countDocuments` (`count`),
  `distinct`, `insertOne`, `insertMany`, `updateOne`, `updateMany`,
  `replaceOne`, `deleteOne`, `deleteMany`.
- **Modificadores encadenados**: `.sort({…})`, `.limit(n)`, `.skip(n)`,
  `.projection({…})`.
- **JSON relajado**: claves sin comillas, comillas simples, comas finales,
  comentarios `//` y `/* */`.
- **Constructores BSON**: `ObjectId(…)`, `ISODate(…)` / `new Date(…)`,
  `NumberLong/Int/Double/Decimal(…)`.

Deliberadamente **no** es un motor de JavaScript. No hay variables, ni
expresiones, ni bucles `for`. Todo lo que quede fuera de la gramática — un método
desconocido, una expresión JS — se rechaza con un error claro en vez de
interpretarse a medias en algo que se ejecuta. Siguen abiertos en el roadmap:
`explain`, `bulkWrite`, `findAndModify`, change streams y GridFS.

## Editar documentos

La **vista de lista** de la tabla se convierte en un editor de documentos con
MongoDB: los valores anidados se pliegan, cada campo se edita en el sitio y
aparecen acciones que una fila SQL no necesita — añadir campo (`$set`), borrar
campo (`$unset`) y un **selector de tipo BSON**.

Tres cosas son deliberadas:

- **Un campo se direcciona por su ruta** (`customData.format`, `tags.2`), no por
  su posición en la vista. Filtrar u ordenar no puede desviar una escritura.
- **Las ediciones conservan el tipo del servidor.** La representación es lossy a
  propósito — `Int32`, `Int64` y `Double` llegan todos como números JSON, y
  `ObjectId`, `Date` y `Decimal128` como cadenas — así que el tipo viaja junto al
  valor en lugar de deducirse de él. Corregir una errata en un `NumberLong`
  vuelve a escribir un `NumberLong`, no un `Int32` que casualmente cabe. El
  selector de tipo es para cuando *sí* quieres cambiar el tipo de un campo.
- **Los valores cuya representación no se puede volver a interpretar no se
  editan en línea**: `Binary`, `DbPointer`, `MinKey`, `MaxKey`. La tabla muestra
  `Binary(Generic, 12 bytes)`, y guardar ese texto no es lo que nadie quiere. Su
  salida es el selector de tipo, que escribe un valor nuevo del tipo elegido.

Un límite: **la clave de un campo no se puede renombrar en el sitio**. Renombrar
es un `$set` de la clave nueva más un `$unset` de la vieja, y hacerlo con
seguridad exige una única actualización atómica a nivel de documento, no las
escrituras por campo que usa esta vista.

## Pipelines de agregación y vistas

Una vista de MongoDB *es* un pipeline de agregación guardado, así que no hay un
editor de vistas aparte: **Nueva agregación…** sobre una colección y **Editar
pipeline…** sobre una vista abren la misma superficie.

- El modo **Etapas** da una tarjeta por etapa: eliges el operador, escribes el
  cuerpo, arrastras para reordenar y puedes desactivar una etapa sin borrarla. El
  modo **Texto** es el pipeline completo como un array. Cambiar de modo exige que
  el pipeline sea válido, y el modo texto no tiene dónde guardar una etapa
  desactivada — te avisa antes de descartarla.
- La **vista previa** se ejecuta mientras escribes, con un debounce, sobre una
  muestra acotada (el control **Muestra**), y cada tarjeta muestra lo que emitió
  *su* prefijo del pipeline. Así ves en qué etapa dejó de casar algo, no solo la
  salida final.
- **`$out` y `$merge` se rechazan**, tanto en la vista previa como en vistas
  guardadas. La previa corre mientras escribes; una etapa de escritura
  sobrescribiría una colección real a media edición.
- **Guardar como vista…** guarda el pipeline como vista (`create`), y volver a
  guardar una vista abierta la actualiza (`collMod`). La salida de la previa es de
  solo lectura: un documento calculado no tiene `_id` por el que escribir de
  vuelta.
- El texto del pipeline lo interpreta el mismo parser que el editor de consultas,
  así que un `ObjectId(…)` en un `$match` sigue siendo un `ObjectId` al ir y
  volver. Abrir una vista y guardarla sin cambios no hace que deje de casar nada
  en silencio. Los tipos sin constructor en la gramática (`Binary`, `Timestamp`,
  `MinKey`, `MaxKey`) caen a Extended JSON — el borde lossy documentado.

## Índices

**Índices…** sobre una colección abre un gestor de índices dedicado. MongoDB es
el único driver que tiene uno, y no porque los demás no tengan índices: los suyos
viven dentro del editor de estructura, diferenciados en `CREATE INDEX` /
`DROP INDEX` junto con el resto de la tabla. MongoDB no tiene DDL que comparar.

- La lista se lee de la respuesta cruda de `listIndexes`, así que **todo
  sobrevive al ir y volver**: la dirección (`1` / `-1`) y el tipo (`text`,
  `2dsphere`, `hashed`) de cada clave, `unique`, `sparse`, TTL
  (`expireAfterSeconds`), `partialFilterExpression`, `collation`, `weights`,
  `hidden` — y lo que no esté modelado explícitamente se conserva como texto
  fuente. Reconstruir `{ createdAt: -1 }` a partir de una lista de nombres de
  campo lo recrearía *ascendente*: invisible en pruebas, permanente en los datos.
- Un índice cuyas claves el selector no puede expresar se abre en modo **crudo**
  en lugar de aplanarse en algo que sí pueda mostrar.
- **Editar es eliminar y crear.** MongoDB no puede alterar un índice sobre la
  marcha, así que la especificación nueva se interpreta y valida *antes* de
  eliminar la vieja, y la confirmación avisa de que la colección se queda sin ese
  índice mientras se construye el nuevo.
- **Ocultar** es el ensayo reversible de **Eliminar**: un índice oculto se
  mantiene al día pero el planificador lo ignora, así que puedes medir lo que
  costaría eliminarlo y deshacerlo al instante. Por eso está justo al lado de
  Eliminar en el menú.
- `_id_` no se puede editar, ocultar ni eliminar — es del servidor, y el backend
  lo rechaza en lugar de solo desactivar el botón.
- **Tamaño** y **Usos** son de mejor esfuerzo, como arriba.
- Las escrituras de índices **no** están expuestas por el conector MCP.

## Renombrar y mover una colección

**Renombrar…** funciona sobre colecciones (`renameCollection` en la base
`admin`), que es también la forma de *mover* una: renómbrala a `otraBase.nombre`
y los documentos se copian en el servidor. Eso tarda lo que la colección sea
grande y necesita privilegios en las dos bases, así que el diálogo lo advierte.
Renombrar sobre una colección existente da error en lugar de eliminarla.

Un movimiento entre bases **cierra las pestañas abiertas de la colección** en
lugar de retitularlas: el destino está detrás de otro nodo de conexión, y una
pestaña retitulada seguiría consultando la base que la colección acaba de dejar.

Una **vista** no se puede renombrar — recréala con el nombre nuevo.

## Lo que no hay (y por qué)

| Superficie | Estado |
| --- | --- |
| Editor de estructura (estilo `ALTER TABLE`) | No aplica. No hay esquema que alterar; los campos se crean al escribirlos. La estructura es de solo lectura y los índices tienen su propio gestor. |
| Exportar / importar `.sql` | No aplica. Una colección se exporta e importa como **JSON** (**Exportar colección (JSON)…** en su menú contextual). |
| Editor del validador `$jsonSchema` | Abierto en el roadmap. Leer y escribir el validador de una colección vía `collMod`. |
| Transacciones multi-documento | Abierto. Necesita una `ClientSession` explícita a través de los helpers de CRUD; y un replica set en el servidor. |
| `_id` con tipo garantizado | Abierto. Un `_id` de 24 caracteres hexadecimales se trata como `ObjectId`; un `_id` que sea una *cadena* de 24 hex es el único caso ambiguo. |
| `explain` | Abierto. El editor de agregación previsualiza la salida pero no muestra el plan. |
| `mongodb+srv://` por túnel SSH | Abierto. Ver «Conectar» arriba. |

`docs/MONGODB_ROADMAP.md` (en inglés) lleva el reparto completo de hecho/diferido
con los puntos de enganche de cada uno.

## Por MCP

Todas las herramientas de lectura funcionan contra MongoDB: `list_databases`,
`list_tables` (colecciones), `describe_table`, `list_indexes`, `browse_table` y
`run_query` con la misma gramática `mongosh` (las lecturas son `find` /
`aggregate` / `countDocuments` / `distinct`). Las de escritura también, con el
mismo nivel de escritura por conexión que los drivers SQL. En una conexión sin
base de datos fijada, pasa `schema` — el nombre de la base — o la lista de
colecciones vuelve vacía. Ver [`MCP.es.md`](MCP.es.md).

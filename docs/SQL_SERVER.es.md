# Microsoft SQL Server

> Nota: este archivo es la traducción al español de `SQL_SERVER.md`. Si ves algo
> desactualizado respecto al original en inglés, ese es el que manda.

SQL Server va por el mismo camino SQL que PostgreSQL y MySQL: explorar, filtrar,
ordenar, editar celdas, insertar y borrar filas, exportar, el panel de seguridad
y el conector MCP. Lo que cambia es la configuración de la conexión, unas cuantas
particularidades de T-SQL y una lista de superficies que todavía no están
escritas.

**Versión mínima: SQL Server 2012.** La paginación usa
`OFFSET … ROWS FETCH NEXT … ROWS ONLY`, que 2008 y anteriores no tienen. Azure
SQL funciona.

Es además el único driver que no está construido sobre `sqlx` — ese proyecto
dejó de soportar MSSQL después de la 0.6 — así que usa `tiberius` con un pequeño
pool de sesiones propio. Es un detalle de implementación con una consecuencia
visible: tras un error de transporte (un socket caído, un fallo de TLS) la sesión
se descarta en lugar de reutilizarse, porque ya no sabemos en qué punto del flujo
TDS estamos. El número de sesiones sale del mismo presupuesto por servidor que
los demás drivers (**Ajustes → Conexiones**), ya que una sesión TDS le cuesta al
servidor lo que un backend de Postgres.

## Conectar

SSMS tiene una sola caja **Nombre del servidor**, así que `HOST\INSTANCIA` es la
forma que la gente escribe. Puedes pegar eso en **cualquiera** de los dos campos
—el de host o el de **Nombre de instancia**— y HuginnDB lo separa: el diálogo
muestra la separación al salir del campo, en lugar de normalizarla en silencio a
tus espaldas.

- **Con nombre de instancia**, el puerto se resuelve por el **SQL Browser**
  (UDP 1434), porque una instancia con nombre normalmente escucha en un puerto
  dinámico. El puerto que hayas escrito se guarda como *alternativa* para cuando
  el Browser esté parado o filtrado — pero solo si no es 1433: reintentar el
  puerto por defecto en un host que descarta UDP solo compra un segundo timeout.
- **Confiar en el certificado del servidor** existe porque SQL Server cifra la
  conexión por defecto y la mayoría de instalaciones on-premise presentan un
  certificado autofirmado, que no se puede validar. Por eso este driver tiene su
  propio interruptor en lugar de la casilla SSL compartida.
- La **autenticación** es un inicio de sesión de SQL Server, o **Windows
  (NTLM)** — esto último solo en Windows, que es donde aparece la opción. En
  Linux y macOS el driver solo admite login de SQL Server.
- **Una instancia con nombre no se puede tunelizar por SSH.** El SQL Browser es
  un servicio UDP aparte, así que la combinación se rechaza de entrada en lugar
  de conectar en silencio al puerto equivocado. Un túnel a una instancia con
  puerto estático conocido sí funciona: indica el puerto y deja vacío el nombre
  de instancia.

Dejar **Base de datos** en blanco te da el servidor entero, igual que en los
otros drivers SQL: el explorador lista las bases y cada una que abras tiene su
propio pool.

## Cómo llegan los valores

| Tipo | Se muestra como | Por qué |
| --- | --- | --- |
| `decimal`, `numeric` | Texto exacto | En el servidor son de precisión arbitraria; pasar por un `f64` los redondearía en silencio. Exactos en los 38 dígitos del tipo, negativos incluidos. |
| `money`, `smallmoney` | Número | El driver los decodifica a doble en la capa de protocolo, antes de que HuginnDB los vea. Exacto hasta unos ±900 mil millones; por encima de eso, usa `decimal` si necesitas los últimos dígitos. |
| `bit` | `0` / `1` | No un booleano JSON, para que la preferencia de visualización de BIT y su editor 0/1 dedicado sigan funcionando. La misma decisión que con el `TINYINT(1)` de MySQL. |
| `binary`, `varbinary`, `image` | Hex `0x…` | La forma literal que T-SQL acepta, así que una celda copiada se pega directamente en una consulta. |
| `uniqueidentifier` | Texto | |
| fechas y horas | Texto tipo ISO | `datetime`, `datetime2`, `smalldatetime`, `date`, `time`, `datetimeoffset`. |

Unos detalles del lado de escritura que no tienes que gestionar, pero que
explican lo que ves en la Consola:

- **La paginación inyecta `ORDER BY (SELECT NULL)`** cuando no has ordenado por
  ninguna columna, porque el `OFFSET/FETCH` de T-SQL exige un `ORDER BY`.
- **Los INSERT usan `OUTPUT INSERTED.<pk>`** para recuperar la clave generada —
  lo que también recoge un `uniqueidentifier` o un default de secuencia, no solo
  `IDENTITY`. SQL Server rechaza `OUTPUT` en una tabla con triggers (error 334),
  así que ese caso se detecta y se reintenta con `SCOPE_IDENTITY()`.
- **Editar una columna binaria envuelve el valor en
  `CONVERT(varbinary(max), …, 1)`.** Los valores viajan como texto, y la
  conversión implícita `nvarchar` → `varbinary` de T-SQL reinterpreta los
  *caracteres*, así que guardar el `0x4A2B` que muestra la tabla almacenaría el
  ASCII de esa cadena.
- **Editar una celda es una transacción de verdad.** La guarda que se niega a
  tocar más de una fila corre como sentencias `BEGIN` / `COMMIT` / `ROLLBACK`
  sobre una sesión retenida, porque `tiberius` no tiene un objeto de transacción.

## Todavía sin implementar

Están cerradas en la interfaz — la acción no aparece, en lugar de fallar al
pulsarla — y también rechazadas en el backend, así que ninguna de las dos puede
derivar en T-SQL incorrecto:

| Superficie | Nota |
| --- | --- |
| Editor de estructura (`ALTER TABLE` visual) | La estructura es de solo lectura. El generador de DDL para T-SQL no está escrito. |
| Renombrar una tabla o una vista | T-SQL renombra con `EXEC sp_rename`, cuyos argumentos son cadenas y no identificadores; va con el resto del trabajo de DDL. |
| Editor de vistas | Crear/editar/eliminar una vista. Las vistas sí se pueden explorar. |
| Exportar e importar `.sql` | Necesita un codificador de literales por driver. Los datos de la tabla siguen exportándose a CSV/JSON. |

Lo que sí funciona hoy, para contrastar: `CREATE DATABASE` / `DROP DATABASE`,
`TRUNCATE` («Vaciar tabla»), eliminar una tabla, el panel de seguridad
(usuarios, roles y privilegios), la exploración multi-base y todas las
herramientas MCP de lectura y de escritura de datos.

## Por MCP

No hay nada específico de SQL Server que configurar: se expone exactamente como
los otros drivers SQL, con el mismo nivel de escritura por conexión. El único
hueco sigue a la tabla de arriba — `apply_structure_change` devuelve un error de
«driver no soportado», así que un asistente puede leer el esquema y escribir
filas pero no alterar el esquema. Ver [`MCP.es.md`](MCP.es.md).

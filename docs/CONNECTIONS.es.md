# Conexiones

> Nota: este archivo es la traducción al español de `CONNECTIONS.md`. Si ves algo
> desactualizado respecto al original en inglés, ese es el que manda.

Una **conexión** es un perfil guardado: qué driver, qué host, qué base de datos,
qué usuario. Hay una única lista global, compartida por todos los entornos (mira
[`ENVIRONMENTS.es.md`](ENVIRONMENTS.es.md) para ver cómo un entorno elige un
subconjunto de ella).

El perfil en sí son metadatos y vive en `profiles.json`, dentro del directorio de
configuración de tu plataforma. **La contraseña nunca.** Va al llavero del
sistema operativo — el Administrador de credenciales en Windows, o libsecret /
GNOME Keyring en Linux — y se lee al conectar. Nada de lo que HuginnDB escribe en
disco contiene una contraseña en texto plano.

## Crear una

**Archivo → Nueva conexión…**, o `Nueva conexión` desde la paleta de comandos
(`Ctrl+Shift+P`). El diálogo se adapta al driver, porque los cinco no necesitan
lo mismo:

| Driver | Qué necesita |
| --- | --- |
| PostgreSQL | Host, puerto, usuario, contraseña. La base de datos es opcional — ver más abajo. |
| MySQL / MariaDB | Lo mismo. |
| SQLite | Solo la **ruta del fichero de base de datos**. Sin host, sin usuario y sin contraseña: el fichero *es* la base de datos, y los permisos del sistema de ficheros son su control de acceso. |
| MongoDB | El formulario construye la URI `mongodb://` en vivo a partir de host/puerto/base/usuario + **Origen de autenticación**. **Editar cadena de conexión** desbloquea la URI para lo que el formulario no cubre: Atlas (`mongodb+srv://`), replica sets, opciones extra de la URI. |
| SQL Server | Host y puerto, más **Nombre de instancia**, **Confiar en el certificado del servidor** y **Autenticación** (inicio de sesión de SQL Server, o Windows/NTLM solo en Windows). Ver [`SQL_SERVER.es.md`](SQL_SERVER.es.md). |

**Nombre** y **Grupo** son solo presentación. El grupo es texto libre: escribe la
misma etiqueta en varias conexiones (un cliente, una sede, un entorno) y la lista
las agrupa. No hay un registro de grupos que mantener, y renombrar uno es
reescribir la etiqueta.

Al editar una conexión existente, dejar **Contraseña** en blanco mantiene la
guardada. Cambiarla significa escribir una nueva, no vaciar el campo.

## Deja la base de datos en blanco para tener el servidor entero

En PostgreSQL, MySQL y SQL Server, un campo **Base de datos** vacío es una
decisión deliberada con su propio comportamiento: el explorador te muestra las
bases de datos del servidor y tú abres las que quieras. Cada base que abres tiene
su propio pool hijo, que se cierra cuando lleva un rato sin usarse.

Dos consecuencias que conviene conocer:

- En PostgreSQL, conectar exige *alguna* base de datos, así que HuginnDB conecta
  a la base de mantenimiento `postgres`, que siempre existe, y lista el resto
  desde ahí.
- En MySQL, una sesión sin base de datos por defecto no tiene `DATABASE()`, así
  que el nodo de primer nivel no lista ninguna tabla. Eso es lo esperado, no un
  fallo: las tablas están bajo el nodo de cada base de datos.

Cuando una conexión alcanza más bases de las que te interesan, acótala con el
selector **Bases de datos a mostrar** del menú contextual de la conexión. Ese
filtro también se puede fijar por entorno, así que un servidor de pruebas
compartido puede mostrar la base de un cliente en un entorno y la de otro en
otro sin duplicar la conexión.

## SSL / TLS

La casilla **SSL** es explícita en los dos sentidos. Desmarcada significa *sin
TLS* (`sslmode=disable` en Postgres, TLS apagado en MySQL), no «inténtalo y si no
tira sin él»: el intento de negociación contra un servidor o un pooler que no lo
habla falla de plano con un error poco útil, así que una casilla desmarcada tiene
que significar texto plano.

SQL Server cifra por defecto y la mayoría de instalaciones on-premise presentan
un certificado autofirmado; por eso tiene su propio interruptor **Confiar en el
certificado del servidor** en lugar de la casilla SSL compartida.

## Túnel SSH

La pestaña **Túnel SSH** convierte la conexión en tunelizada: HuginnDB abre un
listener local, lo reenvía a `(host, puerto)` por un canal SSH `direct-tcpip` y
apunta el driver a `127.0.0.1`. La base de datos no necesita configuración alguna
para esto.

- La **autenticación** es por contraseña o por fichero de clave privada (con
  passphrase opcional). Cualquiera de los dos secretos va al llavero, en una
  cuenta con espacio de nombres propio para que no pueda colisionar con la
  contraseña de la base de datos.
- **Puerto local** a `0` (Auto) deja que el sistema operativo elija un puerto
  libre. Si fijas uno y ya está ocupado, HuginnDB usa uno efímero para esa sesión
  en lugar de fallar la conexión — el perfil guardado no se toca.
- La **verificación del host SSH** es *confiar en el primer uso* por defecto: una
  clave desconocida se registra y, a partir de ahí, una clave **cambiada** se
  rechaza. **Estricta** exige una huella que ya hayas aceptado; **Aceptar
  cualquiera** se salta la comprobación y renuncia a la protección contra MITM.
  Las huellas aceptadas viven en `known_hosts.json` y el diálogo puede olvidar
  una.
- No está disponible para SQLite (un fichero local no tiene a dónde tunelizar) ni
  para `mongodb+srv://` (un registro SRV resuelve a varios hosts del replica set,
  y un túnel solo puede dar frente a uno — usa una URI directa
  `mongodb://host:puerto` para tunelizar MongoDB).

## Límites de conexiones

**Ajustes → Conexiones** gobierna cuántas conexiones mantendrá HuginnDB — y
muestra arriba cuántas hay abiertas ahora mismo. Conviene recordar que otros
clientes de la misma máquina (los orígenes de datos de un IDE, el pool de una
aplicación, un sidecar `huginndb-mcp`) cuentan también contra los límites *del
servidor*, aunque HuginnDB no los vea:

| Preferencia | Qué acota |
| --- | --- |
| Máximo de conexiones por servidor | El **total** contra un servidor, compartido por todas las conexiones y vistas de base de datos que lleguen a él. |
| Máximo de conexiones por vista de base de datos | El techo de cada pool por base de datos. Son los pools que se multiplican al explorar, así que es bajo a propósito. |
| Máximo de vistas de base de datos abiertas | Cuántas vistas puede mantener una conexión a la vez; las que llevan más tiempo sin usarse se cierran al pasar de aquí. `0` es sin límite. |
| Cerrar vistas inactivas tras | Segundos que una vista puede pasar sin usarse antes de cerrar su pool. Se reabre sola la próxima vez. `0` desactiva el cierre. |
| Intervalo de keepalive | Segundos entre pings de comprobación — ver más abajo. `0` apaga el latido. |

Los límites se aplican al *abrir* un pool; los ya abiertos conservan lo que se
les concedió, así que reconecta para aplicar un cambio al momento. Y cuando se
agota el presupuesto de un servidor, abrir otra vista de base de datos cierra la
que hace más tiempo que no usas en lugar de fallar.

Un solo servidor puede llevar además su propio techo: **Máximo de conexiones para
este servidor**, en el diálogo de conexión, pisa la preferencia global solo para
ese perfil. La capacidad de conexiones es un hecho del servidor, no de tu sesión,
y por eso se guarda en el perfil: así viaja con él a las exportaciones, a los
orígenes compartidos y al conector MCP.

En la misma sección hay otro interruptor: **Compartir pools con el conector MCP**
permite que un sidecar `huginndb-mcp` en ejecución use las conexiones de esta app
en lugar de abrir las suyas, de modo que toda la máquina comparta un presupuesto
por servidor. Abre un listener en localhost protegido por token y está desactivado
por defecto — ver [`MCP.es.md`](MCP.es.md).

## Keepalive y conexiones perdidas

Una conexión inactiva la puede cortar sin avisar un NAT, un balanceador o un
cortafuegos corporativo: el pool sobrevive en memoria y la *siguiente* consulta
falla con un error opaco del driver. Un latido hace ping periódicamente a cada
conexión de primer nivel (**Ajustes → Conexiones → Intervalo de keepalive**; `0`
lo desactiva), lo que mantiene el socket — y el canal SSH de un túnel — en uso, y
sirve además como detector de las caídas que no puede evitar. Un ping fallido
marca la conexión, y tanto la lista de conexiones como la barra de estado ofrecen
**Reconectar** en un clic en vez de dejar que te enteres a mitad de una consulta.

Las vistas por base de datos no se pinguean aparte: dependen de la misma
liveness de TCP o del túnel que su padre y son baratas de reabrir.

## Abrir una conexión desde la línea de comandos

| Flag | Significado |
| --- | --- |
| `--connect-profile <nombre>` | Conecta un perfil guardado por nombre visible. |
| `--connect-profile-id <id>` | Igual, por id de perfil — sin ambigüedad si dos perfiles comparten nombre. |
| `--host`, `--port`, `--database`, `--username` (`--user`) | Conexión ad-hoc, sin perfil guardado. |
| `--password` (`--pass`) | Opcional. Pisa la contraseña guardada de un perfil, o aporta una para una conexión ad-hoc. |
| `--driver <nombre>` | `postgres`, `mysql`, `sqlite`, `mongodb`, `sqlserver` — más los alias habituales (`postgresql`, `pg`, `mariadb`, `mssql`, `azuresql`, …). |
| `--connection-string` / `--uri` | URI completa. Es la vía principal para MongoDB, e implica `--driver mongodb` si no se indica driver. |
| `--auth-source` | Base de autenticación de MongoDB, para la forma ad-hoc sin URI. |
| `--name` | Nombre visible de la conexión ad-hoc. |

Funcionan tanto `--flag valor` como `--flag=valor`, y el valor se parte en el
*primer* `=`, así que una contraseña que contenga uno sobrevive.

Una conexión ad-hoc es **efímera por construcción**: vive en memoria para que el
explorador y las pestañas la traten como cualquier otra, pero se filtra al
guardar los perfiles, y una `--password` dada así se pasa directamente a la
llamada de conexión — nunca llega a `profiles.json` ni al llavero. Cierras la app
y desaparece.

Lanzar la app una segunda vez no abre una segunda app: los argumentos se
reenvían a la instancia en ejecución, que conecta en la ventana que ya tienes.

## Exportar e importar

**Archivo → Exportar perfiles…** escribe un `.json` a partir de una lista de
conexiones con casillas. **Incluir contraseñas (cifradas)** añade cada secreto —
tanto la contraseña de la base de datos como el secreto SSH — cifrado con
AES-256-GCM bajo una clave derivada de tu passphrase (PBKDF2-HMAC-SHA256, 600 000
iteraciones). Cada secreto lleva su propio salt y nonce, así que una entrada
corrupta no se lleva por delante el resto del fichero. La passphrase no se guarda
en ningún sitio y no se puede recuperar.

**Archivo → Importar perfiles…** lo lee de vuelta. Los conflictos se detectan por
**id** de perfil, no por nombre — una conexión renombrada en cualquiera de los
dos lados sigue siendo la misma conexión — y cada uno se resuelve por separado
como **Sobrescribir**, **Omitir** o **Mantener ambas**. Un perfil importado de un
fichero exportado *sin* contraseñas llega sin ella, y el resumen de la
importación lo dice: ponla antes de conectar.

Una advertencia específica de MongoDB. El fichero exportado lleva todos los
campos del perfil tal cual, `connection_string` incluida, y esa cadena **no** se
cifra — solo se cifran los secretos del llavero. Una URI construida por el
formulario no incrusta la contraseña, así que no pasa nada; una URI que hayas
editado a mano para incluir `usuario:contraseña@` viajaría en texto plano. Quita
las credenciales de la URI antes de exportar, o trata el fichero como un secreto
en sí mismo.

## Orígenes compartidos

**Ajustes → Orígenes** es la versión para varias personas de la importación: en
lugar de pasarse ficheros, alguien mantiene un bundle exportado en una ruta que
todo el mundo ya tiene montada — un recurso UNC, una unidad de red, una carpeta
sincronizada — y el resto lo registra como **origen** y tira de ahí.

- No hay protocolo ni servicio. Leer un origen es leer un fichero, y la ACL del
  recurso compartido es el control de acceso. Si el fichero está cifrado, su
  passphrase va a tu llavero (nunca a disco) y viaja fuera de banda: quien
  mantiene el recurso te la dice.
- Conviene tener claro qué compra ese cifrado: acceso de lectura al recurso
  **más** la passphrase entrega todas las contraseñas del fichero. La ACL es el
  perímetro real. Ver [`SECURITY.md`](../SECURITY.md) (en inglés).
- Una conexión importada de un origen es **de solo lectura en la app**: es una
  copia de la entrada de otra persona, y editarla en local la deshacería la
  siguiente sincronización. Para variarla, duplícala: la copia es una conexión
  local normal.
- Los orígenes se registran por entorno, y HuginnDB solo los *lee*.
- Cuando quien lo mantiene deja de publicar una conexión que ya te habías
  traído, no se borra a tus espaldas. Se marca y decides tú: **Conservar como
  mía** (pasa a ser una conexión local y editable) o **Eliminar** (que quita
  también su contraseña de tu llavero).

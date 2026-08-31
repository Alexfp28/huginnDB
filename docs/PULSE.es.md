# Pulse

> Nota: este archivo es la traducción al español de `PULSE.md`. Si ves algo
> desactualizado respecto al original en inglés, ese es el que manda.

HuginnDB ya te dice qué hay *dentro* de una base de datos. Pulse responde a
una pregunta distinta: ¿cómo está el *servidor* ahora mismo, y cómo ha estado
en los últimos días? Constantes vitales en vivo, las sentencias en las que
más tiempo ha invertido, sus tablas más grandes, quién está conectado, y qué
índices no lee nadie — todo en un mismo sitio, sin salir de la app.

Pulse funciona con **MySQL y MongoDB** hoy en día. Abrirlo contra Postgres,
SQLite o SQL Server muestra un estado explícito de "aún no soportado" en vez
de una pared de ceros — los demás drivers simplemente no exponen las
estadísticas que Pulse necesita.

## Abrir Pulse

Haz clic en el icono de pulso de la barra de actividad derecha para acoplar
el panel junto a tu espacio de trabajo — sigue a la conexión que tengas
seleccionada, o fíjalo con el icono de chincheta para anclarlo a una conexión
concreta pase lo que pase en el resto de la app.

El panel acoplado es deliberadamente compacto: cuatro secciones (Estado,
Avisos, Dónde va el tiempo, Almacenamiento), cada una mostrando las primeras
filas y un botón **↗** en la cabecera. Al pulsarlo se abre Pulse en su propia
ventana — más ancha, con las tablas completas y dos vistas más (Sesiones,
Índices) que no caben en un panel lateral. Esa ventana mide una sola
conexión y se cierra de forma independiente a la ventana principal; nada de
lo que muestra se guarda como pestaña.

## Qué muestra cada vista

### Estado

Consultas por segundo, presión de conexiones, hilos en ejecución y tasa de
aciertos del buffer pool (o de la caché de WiredTiger), cada una con una
pequeña gráfica en vivo, más los avisos derivados de ellas — acercarse al
límite de conexiones, una tasa de aciertos de caché baja, tablas temporales
yéndose a disco, conexiones rechazadas. Las cifras en vivo se actualizan
cada cinco segundos **solo mientras el panel o la ventana están en
pantalla** — cambia de vista, pliega el panel, o minimiza la app, y el
sondeo se detiene con ello.

### Dónde va el tiempo

Las sentencias en las que el servidor ha invertido más tiempo ("Consultas"):
en MySQL se lee de la tabla de digests de `performance_schema`; en MongoDB,
de la colección `system.profile` del profiler de la base de datos — actívalo
para que esto muestre algo (los avisos de la vista Estado te dicen si está
apagado). Cada fila muestra cuántas veces se ha ejecutado, su duración media
y la más lenta, filas examinadas frente a devueltas, y una insignia roja
cuando se resolvió sin usar ningún índice.

Una fila con un botón **Plan** lleva guardado junto a ella un ejemplo real y
ejecutable de esa sentencia — púlsalo para ver el plan que usaría el
servidor, sin llegar a ejecutar la sentencia de verdad.

### Almacenamiento

Las tablas/colecciones más grandes de la conexión, clasificadas, desglosadas
en datos, índices y espacio libre — el espacio que una reconstrucción
devolvería.

### Sesiones

*Solo en la ventana ampliada.* Cada sesión u operación abierta ahora mismo
en el servidor: el `SHOW FULL PROCESSLIST` de MySQL, las operaciones activas
o esperando un bloqueo de MongoDB. En MySQL, una sesión esperando un
bloqueo muestra a qué otra sesión está bloqueada. Es una foto en vivo con su
propio botón de actualizar, no algo que se actualiza solo — sondear cada
cinco segundos una lista completa de sesiones costaría más de lo que vale.

### Índices

*Solo en la ventana ampliada.* Cada índice de tus tablas más grandes,
clasificado por cuántas veces se ha leído realmente desde el último reinicio
de los contadores. Un índice marcado como **sin usar** ha recibido cero
lecturas — vale la pena mirarlo, pero nunca es una sugerencia de Pulse para
que lo elimines sin más: "sin usar desde el último reinicio del servidor" no
es la misma afirmación que "seguro de eliminar", y Pulse solo te dice la
primera.

### Histórico

*Solo en la ventana ampliada.* Las mismas cifras en vivo, pero de las
últimas 24 horas, 7 días o 30 días, para poder responder "¿esto ya iba lento
ayer?" en vez de solo "¿va lento ahora mismo?". Esta vista necesita que se
haya registrado histórico de verdad — ver [Conservar histórico](#conservar-histórico).

## Conservar histórico

Todo lo anterior a la vista Histórico es solo en vivo — cierra la ventana y
desaparece. Para conservar un registro, activa el muestreador de histórico
de Pulse para una conexión en **Ajustes → Pulse**: un árbol con tus
conexiones, cada una con su interruptor, junto a los propios ajustes del
muestreador (con qué frecuencia muestrea, cuánto tiempo conserva el
histórico, un límite de tamaño en disco, y si sigue muestreando mientras
HuginnDB está minimizada).

Está **desactivado por defecto, por conexión** — activarlo en una conexión
nunca empieza a vigilar otra. Una vez activado, HuginnDB lee las constantes
vitales de esa conexión en segundo plano (una vez por minuto por defecto) y
las añade a una pequeña base de datos local, completamente aparte de
cualquier cosa que la propia conexión almacene. El histórico con más de 48
horas se va reduciendo poco a poco para mantener el fichero pequeño, y lo
que supera la ventana de retención se borra del todo.

## Preguntarle a un asistente de IA

Todo lo que muestra Pulse también está disponible para un cliente de IA
conectado a través del [conector MCP](MCP.md) de HuginnDB —
`pulse_health`, `pulse_metrics`, `pulse_top_queries`, `pulse_explain`,
`pulse_storage`, `pulse_sessions` y `pulse_index_usage`. Las siete son de
solo lectura: un asistente puede preguntar "por qué va lento este servidor"
o "qué le pasó la semana pasada" y recibir cifras reales, pero nunca puede
cambiar nada a través de ellas. Consulta la propia guía del conector para
saber cómo conectar un cliente en primer lugar.

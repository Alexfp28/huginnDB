# El panel de IA

HuginnDB puede hablar con un modelo de lenguaje sobre tu base de datos. Todo el
diseño existe para responder primero a una objeción, porque es la correcta:

> *Los datos de mi cliente no van a ir a un tercero.*

Así que la respuesta no es una casilla y una promesa. **El modelo con el que
hablas es el que tú le indiques a HuginnDB** — un proceso en tu propia máquina,
una caja con GPU en tu propia red, o un proveedor en la nube con tu propia
clave, y nada por medio. No hay ningún servicio de HuginnDB en el medio, y no
existe ninguna configuración en la que tus datos pasen por nosotros.

El panel está **apagado** hasta que lo enciendas, y todas las conexiones son
**inalcanzables** para él hasta que marques esa conexión en concreto.

---

## Dos preguntas, mantenidas aparte

Casi todas las herramientas las confunden. Confundirlas es el error.

**1. ¿Dónde corre la inferencia?** En loopback, en tu LAN, en una pasarela que
tú operas — o en los servidores de otro. Se lo dices tú a HuginnDB; nunca lo
adivina. Un nombre como `ai-internal` resuelve donde diga el DNS, y el DNS no es
una frontera de seguridad, así que "¿este endpoint es mío?" es una pregunta que
solo puedes responder tú. Ajustes → IA rellena una propuesta detectando loopback
y rangos privados, y guarda *tu* respuesta.

**2. ¿Qué llega al contexto del modelo?** Metadatos — nombres de tablas y
columnas, tipos, índices, definiciones de vistas, salida de `EXPLAIN` — o
metadatos **más filas**.

Son independientes, y "solo lectura" no es la misma promesa que "no sale nada".
Un asistente de solo lectura que ejecuta `SELECT * FROM pacientes LIMIT 50` ha
enviado cincuenta registros de pacientes a lo que haya configurado. Por eso hay
dos interruptores y no uno.

### La regla, aplicada en Rust

| Confianza del endpoint | La conexión permite filas | Qué puede ver el modelo |
| --- | --- | --- |
| Mi infraestructura | — | Metadatos **y** filas |
| Terceros | No | Solo metadatos |
| Terceros | Sí | Metadatos **y** filas |

Con solo metadatos, las herramientas que leen filas **no se le ofrecen al
modelo en absoluto** — están ausentes de la lista que recibe, no
presentes-y-rechazadas. Un modelo que ve una herramienta que no puede usar se
gasta los turnos intentándolo.

Fíjate en la asimetría: un endpoint **de confianza** lee filas diga lo que diga
el interruptor por conexión. Para mantener una conexión completamente lejos del
asistente, quítale el *alcance*, no las filas.

Sea cual sea el ajuste, **todo lo que pegues tú en el chat se envía.** La regla
gobierna lo que lee el asistente por iniciativa propia; una selección de la
cuadrícula que pegas eres tú eligiendo enviarla.

---

## Qué hardware hace falta

Aproximadamente, con cuantización de 4 bits:

| Máquina | Modelo viable | Llamadas a herramientas encadenadas fiables |
| --- | --- | --- |
| Sin GPU, 8–16 GB RAM | 3B–4B; 7–8B a 2–6 tok/s | No |
| GPU 8 GB | 7–8B | Justo |
| GPU 12–16 GB | 14B | Sí |
| GPU 24 GB+ / host vLLM | 32B | Sí, con holgura |

Los modelos pequeños son precisamente los que fallan encadenando llamadas a
herramientas, así que "usa un modelo más pequeño" no es un camino de
degradación. Por eso hay dos modos, y por eso el pequeño no es un premio de
consolación — ver más abajo.

### El despliegue que de verdad funciona en una oficina

**Una caja con GPU sirviendo a todos.** Ollama, `llama-server` de llama.cpp y
vLLM exponen un endpoint compatible con OpenAI **por red**, así que la máquina
que corre el modelo no tiene que ser la máquina en la que trabajas:

```
Ajustes → IA → Endpoint:  http://ai-internal:11434/v1
Ajustes → IA → Confianza: Mi infraestructura
```

Este es el patrón documentado principal, no una nota al pie. Se permite `http`
sin cifrar exactamente por eso — una regla de solo-https rompería el despliegue
para el que está pensada la función. Cualquier esquema que no sea `http` o
`https` se rechaza, y también se rechazan las redirecciones: un endpoint de
inferencia no tiene por qué redirigir una completion, y seguir una haría inútil
la lista blanca de endpoints.

### Elegir modelo

Para una gráfica de 12 GB, de la biblioteca actual de Ollama:

| Modelo | Tamaño | Por qué |
| --- | --- | --- |
| `gemma4:12b` | 7,6 GB | Lo más capaz que entra con margen para contexto, y con muchísima diferencia el más descargado — lo que en la práctica significa que su plantilla de llamadas a herramientas es la más rodada. |
| `lfm2.5:8b` | 5,2 GB | 8B con 1B activo, construido específicamente para llamadas a herramientas rápidas y fiables en hardware de consumo. Lo bastante barato para tenerlo al lado del primero como comparación. |
| `granite4.2:8b` | 5,3 GB | Apache 2.0, uso de herramientas y salida JSON estructurada. |

La etiqueta más pequeña de `qwen3.6` es 27b (~17 GB) y no entra; tampoco
`muse-glimmer:30b` ni `gemma4:26b`.

### Súbele la ventana de contexto a Ollama

**Esta es la causa más común de que el asistente se comporte de forma rara.** El
contexto por defecto de Ollama es pequeño y trunca **por el principio** — que es
donde viven el prompt del sistema y tu pregunta. Un modelo al que le llega un
resultado grande y un prompt truncado responderá a una pregunta que ya no puede
ver, a menudo en otro idioma:

```bash
OLLAMA_CONTEXT_LENGTH=16384 ollama serve
```

HuginnDB acota lo que envía (ver *Presupuestos* más abajo) para que un contexto
pequeño se degrade en vez de romperse, pero no puede hacerlo más grande.

---

## Modo asistido

**Una sola llamada al modelo. HuginnDB monta el contexto él mismo.** Sin bucle de
herramientas, así que funciona en un modelo demasiado pequeño para confiarle uno
— y para estos cuatro trabajos es *mejor* que el modo agente, porque el contexto
se eligió a propósito en vez de descubrirse.

| Trabajo | Dónde | Qué envía HuginnDB |
| --- | --- | --- |
| **Explica esta sentencia** | Clic derecho en el editor de consultas | La sentencia (o tu selección) y el producto y versión del servidor. |
| **¿Por qué es lenta esta sentencia?** | Clic derecho en el editor, o el botón de las filas de sentencias lentas de Pulse | La sentencia más el plan que usaría el propio servidor. |
| **Escribir SQL** | La varita del compositor del panel | Tu petición más la estructura de las tablas de las que parece hablar. |
| **Documentar con IA** | Clic derecho en una tabla del árbol de esquema | Columnas, índices y — solo cuando el endpoint puede leer filas — un puñado de valores de muestra. |

Documentar es el único que lee filas. Con un endpoint de solo metadatos no se
desactiva: quita la muestra y le dice al modelo que no hable de valores que no ha
visto.

La coincidencia de tablas de la varita es deliberadamente tonta y determinista:
una tabla es relevante cuando su nombre aparece en tu petición. Corre *antes* de
la única completion que la tarea tiene permitida, así que algo más listo sería
una segunda inferencia eligiendo el contexto de la primera. Cuando no coincide
nada va la lista entera de tablas y el modelo pregunta — un fallo mejor que un
subconjunto seguro y equivocado.

---

## Modo agente

**Un bucle real de llamadas a herramientas**: el modelo pide lo que necesita,
HuginnDB lo lee, y sigue hasta que puede responder.

Está condicionado a una **medición, no a una preferencia**. *Probar endpoint* en
Ajustes → IA le pregunta al endpoint por sus modelos (una cortesía —
`llama-server` y varias pasarelas no lo implementan, y eso no es un error) y
luego hace una llamada pequeña a una herramienta. Tres resultados:

- **Con herramientas** — el modo agente está disponible.
- **Solo chat** — el modelo completa pero no emite llamadas a herramientas
  utilizables. El modo asistido está disponible; el agente no, y el panel lo
  dice.
- **Inalcanzable** — con el motivo del propio servidor, literal.

Un modelo pequeño al que le pides encadenar llamadas a herramientas no se
degrada con elegancia. Se lo inventa, y el asistente parece estar funcionando
hasta justo el punto en el que resulta que nada de lo que dice haber leído se
leyó nunca. Condicionarlo a la sonda es lo que evita que eso sea tu problema y
lo descubras tú.

### Las herramientas que recibe

De solo lectura, todas. **Ninguna escritura está en la lista**, y un `run_query`
que lleve algo que no sea una lectura se rechaza con la instrucción de proponer
la sentencia en su lugar.

`list_databases`, `list_tables`, `describe_table`, `list_indexes`,
`server_version`, `get_view_definition`, `pulse_explain`, `pulse_top_queries`,
y — solo cuando el alcance permite filas — `run_query` y `browse_table`.

Usuarios y permisos se retienen a propósito: quién puede iniciar sesión y qué
puede hacer es lo más atacable que HuginnDB puede leer, y ninguna tarea lo
necesita.

### Míralo trabajar

Cada paso va a la **Consola**, con su propio filtro **IA**: las herramientas que
se le ofrecieron y si incluían acceso a filas, cada llamada con sus argumentos, y
el **número de filas y el tamaño** de cada resultado. El contenido nunca — esos
son los datos de los que trata toda esta página, y escribirlos en un panel del
que puedes copiar sería una forma rara de cumplir la promesa.

Esta es la parte que hace la garantía comprobable en vez de solo enunciada.
Léela una vez contra una conexión que te importe.

### Presupuestos

Un turno se para en lo que llegue primero: seis llamadas al modelo, doce
lecturas, el equivalente a tres respuestas de texto de resultados acumulado, o
el límite de filas de Ajustes. Llegar a uno termina el turno y dice cuál en la
respuesta — "el modelo se rindió" y "al modelo lo cortaron" son hechos distintos
y solo uno merece reintentarse.

---

## Nunca escribe

El asistente propone; tú ejecutas. Una sentencia que sugiera aparece en un editor
pequeño de solo lectura con una acción **abrir en el editor** por sentencia, que
la entrega a una pestaña de consulta — donde ya están la confirmación de
sentencias destructivas, el rechazo de escrituras sin filtro, la entrada en la
Consola y el historial.

Esto no es una limitación esperando a que la levanten. Un asistente capaz de
escribir es una decisión aparte con un modelo de amenazas aparte, no un ajuste.

---

## Si ya pagas Claude o ChatGPT

**Esas suscripciones no se pueden gastar a través de HuginnDB, y no es nuestra
decisión.** Los términos de Anthropic dicen que OAuth está "destinado
exclusivamente a … el uso ordinario de Claude Code y otras aplicaciones nativas
de Anthropic" y que quien construya productos "debería usar autenticación por
clave de API". El inicio de sesión de ChatGPT de OpenAI está limitado a sus
propios clientes de la misma manera. Cualquier herramienta que afirme lo
contrario está haciendo algo que su proveedor le ha dicho que no haga.

La vía autorizada es la dirección opuesta: **Ajustes → MCP**. El conector
`huginndb-mcp` deja que Claude Code, Claude Desktop o Cursor lean tus bases de
datos *a través* de HuginnDB, usando la licencia que ya tienes. Ver
[MCP.es.md](MCP.es.md).

| Lo que quieres | Usa | ¿Salen datos? |
| --- | --- | --- |
| Gastar tu licencia de Claude/Codex existente | `huginndb-mcp` en ese cliente | Sí, a ese proveedor |
| Un chat dentro de HuginnDB sin que salga nada de tu infraestructura | Este panel, endpoint local o autoalojado | No |
| Un chat dentro de HuginnDB con un modelo de frontera | Este panel, con tu propia clave de API | Sí |

---

## Referencia de ajustes

**Ajustes → IA**

| Ajuste | Qué hace |
| --- | --- |
| Activar el panel de IA | Desactivado en toda instalación existente. Mientras esté apagado, HuginnDB no hace ninguna petición a ningún endpoint. |
| Endpoint | Una URL base compatible con OpenAI. Normalmente tiene que acabar en `/v1`. |
| Modelo | El id del modelo. Pasa a ser una lista una vez hecha la comprobación del endpoint. |
| Confianza del endpoint | Tu declaración. Ver *Dos preguntas* arriba. |
| Modo | Asistido o agente. El agente exige además que la sonda diga que hay herramientas. |
| Esfuerzo | `reasoning_effort` para un modelo de razonamiento. **Automático** no envía nada, que es el único ajuste que ningún endpoint puede rechazar — OpenAI rechaza el campo de plano en un modelo que no razona. Para un modelo local en modo asistido, quita el esfuerzo. |
| Presupuesto de filas | Cuántas filas puede meter en el contexto del modelo la respuesta de una herramienta. Tope de 1000; encima se aplica un presupuesto de caracteres. |
| Tiempo de inactividad | Segundos sin recibir un byte antes de abandonar una petición. No es un presupuesto total — un modelo lento no es un modelo roto. |
| Clave de API | Solo hace falta para un proveedor en la nube. Se guarda en el llavero del sistema, ligada al host de ese endpoint, así que cambiar el endpoint no puede enviarla a otro sitio. HuginnDB no la vuelve a mostrar y ningún comando la devuelve. |
| Conexiones | Dos interruptores cada una: **alcance** (¿puede el asistente ver esta conexión siquiera?) y **filas**. Los dos apagados por defecto, los dos estrictamente locales — se preservan al sincronizar un origen compartido y se limpian al importar, porque lo que un modelo puede leer en *tu* máquina no lo decide quien publica a dos máquinas de distancia. |

**La conversación nunca se escribe en disco.** Contiene nombres de esquema, SQL
propuesto y fragmentos de filas, que es exactamente el artefacto que esta función
promete no acumular. Cerrar la app la olvida. Esa es la promesa, no una función
que falta.

---

## Asperezas conocidas

- **Los modelos pequeños usan sus herramientas menos de lo que deberían, y el
  panel ya lo compensa.** Algunos modelos terminan un turno escribiendo un
  `SELECT` y esperando a que lo ejecutes tú, incluso teniendo una herramienta
  `run_query` en la mano. Cuatro causas eran nuestras y están corregidas: se le
  dice al asistente a qué motor y a qué base de datos está conectado (así deja
  de probar `LIMIT` en SQL Server o SQL en MongoDB), `DESCRIBE` se reconoce como
  la lectura que es en lugar de rechazarse como escritura, a un lote o a un
  `USE` se le responde qué corregir en vez de "dáselo al usuario", y una
  conexión MongoDB abierta en una base de datos funciona.

  Para lo que queda — el criterio del propio modelo — el bucle ya no depende de
  convencerlo. Cuando una respuesta te entrega una lectura, en un turno que no
  leyó ninguna fila y en una conexión donde las filas están permitidas, el panel
  le pide al modelo esa única llamada y responde con las filas. Ocurre como
  máximo una vez por turno, nunca con una sentencia que escribe, y el paso extra
  queda en la Consola como todos los demás.
- **La prosa se renderiza como un subconjunto pequeño de markdown** — negrita,
  cursiva, código en línea, listas, encabezados, citas y bloques de código. Las
  tablas todavía no.
- **Los enlaces de una respuesta se muestran, no se pueden clicar.** Una URL
  escrita por un modelo que te abriera el navegador con un clic es una decisión
  que hay que tomar a propósito.

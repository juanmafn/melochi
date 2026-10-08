# Melochi — Documento de diseño (GDD)

> v0.4 · 2026-10-07 · Estado: **fase 1 implementada, fase 2 (Spotify) en pruebas**

## 1. Concepto

**Melochi** es una mascota virtual tipo Tamagotchi que vive como *overlay* en el escritorio de Windows. Tiene necesidades y estados de ánimo, se puede hablar con ella por un chat pequeño (IA local con Ollama), se la cuida con objetos que ella misma suelta al jugar, y **controla tu Spotify según su estado de ánimo**: cuando está contenta te sugiere música alegre; cuando la descuidas se cabrea y te hace putaditas (pausarte la música, secuestrarte la playlist con música spooky…).

Todo lo visual y sonoro es **editable por el usuario** (skins con PNG / sprite sheets + JSON).

- El juego se llama **Melochi**; la mascota la nombra el usuario al crearla.
- La mascota es una **criatura inventada** (diseño libre del usuario).
- No crece ni evoluciona: lo que cambia es su **comportamiento** según cómo la trates.
- **Nunca muere ni enferma.** El castigo por descuidarla es que se cabrea y hace travesuras.

### Pilares de diseño
1. **Viva pero no pesada**: se nota que está ahí, pero respeta juegos, llamadas y el modo "No molestar".
2. **La música es su forma de expresarse**: sugiere cuando está bien, sabotea cuando está mal.
3. **Cuidarla es jugar con ella**: jugar suelta objetos → los objetos la cuidan → bucle positivo.
4. **Todo personalizable**: gráficos, sonidos, estados de ánimo, personalidad y playlists son archivos editables.

---

## 2. Bucle de juego

```
 Jugar / interactuar ──► Suelta objetos (drops) ──► Inventario
        ▲                                               │
        │                                               ▼
 Ánimo alto: sugiere música      ◄──── Darle comida / bebida / juguetes
 Ánimo bajo: travesuras  ◄──── Necesidades bajan con el tiempo
```

---

## 3. Estadísticas

Todas van de 0 a 100. Bajan con el tiempo **mientras el programa está abierto, estés delante o no** (si te vas sin cerrarla, cuenta como ignorarla). Al cerrar el programa, el tiempo se congela.

| Stat | Visible | Sube con | Baja con |
|---|---|---|---|
| **Hambre** (100 = llena) | Sí | Comida | Tiempo |
| **Sed** (100 = hidratada) | Sí | Bebida | Tiempo |
| **Diversión** | Sí | Jugar, juguetes, minijuegos, música que le gusta | Tiempo, aburrimiento |
| **Cariño** | Sí | Caricias, chat, aceptar sus sugerencias | Ignorarla, rechazar sugerencias |
| **Mosqueo** | No (se intuye por la animación) | Descuido, rechazos repetidos, saltar *su* canción, abusar del "No molestar", lanzarla demasiado | Cuidados, regalos favoritos, tiempo con stats altas |
| **Afinidad** (-100…100) | **Sí** (corazón/nivel en el panel de stats) | Buen trato sostenido a largo plazo | Descuido sostenido |

- **Mosqueo** es lo que lleva al estado "cabreada" y desencadena las travesuras.
- **Afinidad** es la relación a largo plazo: matiza la personalidad (más cariñosa o más rencorosa) y cuánto aguanta antes de cabrearse.
- Velocidades de bajada configurables en `config/stats.json`.

### 3.1 Ritmo objetivo
**Ignorándola por completo desde stats llenas, tarda ~2 horas en cabrearse.** Valores de partida (a ajustar en pruebas):

| Stat | Ritmo aprox. | De 100 a nivel crítico |
|---|---|---|
| Hambre | −0,6 / min | ~2 h 30 min hasta 10 |
| Sed | −0,75 / min | ~2 h hasta 10 |
| Diversión | −0,5 / min | ~2 h 30 min hasta 25 |
| Cariño | −0,4 / min | ~3 h hasta 25 |
| Mosqueo | +0 si todo va bien; sube cada vez más rápido cuantas más stats estén por debajo de 30 | llega a 70 ~2 h después de empezar a ignorarla |

Con Afinidad alta aguanta algo más (hasta +30 %); con Afinidad baja, menos.

---

## 4. Estados de ánimo (configurables)

Los moods se definen en `config/moods.json`. Cada uno tiene **condiciones** sobre las stats, una **prioridad**, y define sus **animaciones, playlists, sonidos, tono del chat y comportamiento**. Se evalúa periódicamente y gana el de mayor prioridad cuyas condiciones se cumplan; si ninguno, se usa `neutral`. Un mood tiene que mantenerse ~30 s antes de cambiar (histéresis) para evitar parpadeos.

Moods de ejemplo incluidos: **`neutral`** (obligatorio, fallback), **`feliz`** y **`cabreada`**.

```jsonc
{
  "id": "feliz",
  "nombre": "Feliz",
  "prioridad": 10,
  "condiciones": { "todas": [
    { "stat": "diversion", ">=": 60 },
    { "stat": "carino",    ">=": 60 },
    { "stat": "hambre",    ">=": 40 },
    { "stat": "sed",       ">=": 40 }
  ]},
  "animaciones": { "idle": "feliz_idle", "walk": "feliz_walk" }, // si faltan, usa las genéricas
  "musica": {
    "playlists": ["spotify:playlist:XXXX", "spotify:playlist:YYYY"],
    "modo": "sugerir"            // "sugerir" | "travesura" | "ninguno"
  },
  "sonidos": { "ambiente": ["risita.ogg"] },
  "tono_chat": "alegre y juguetona, usa exclamaciones",
  "comportamiento": { "exploracion": 0.7, "habla_sola": 0.5, "travesuras": false }
}
```

```jsonc
{
  "id": "cabreada",
  "nombre": "Cabreada",
  "prioridad": 100,
  "condiciones": { "alguna": [
    { "stat": "mosqueo", ">=": 70 },
    { "stat": "hambre",  "<=": 10 },
    { "stat": "sed",     "<=": 10 }
  ]},
  "musica": { "playlists": ["spotify:playlist:SPOOKY"], "modo": "travesura" },
  "tono_chat": "borde, sarcástica, rencorosa, respuestas cortas",
  "comportamiento": { "exploracion": 0.9, "habla_sola": 0.8, "travesuras": true }
}
```

---

## 5. Música y Spotify

**Requisito:** Spotify Premium (el usuario lo tiene). Se usa la Web API de Spotify con OAuth PKCE.

**Conexión:** Spotify exige que cada usuario cree su propia app de desarrollador (modo desarrollo: máx. 5 usuarios, el dueño necesita Premium). La ventana **Ajustes → Música…** guía los pasos: crear la app, añadir la Redirect URI `http://127.0.0.1:8977/callback`, pegar el Client ID y conectar. El token se guarda cifrado con la protección de datos de Windows.

> Limitaciones de la API (cambios de noviembre 2024 y febrero 2026): sin recomendaciones, sin *audio features*, sin "canciones top de un artista", sin popularidad ni playlists editoriales, búsqueda limitada a 10 resultados, y solo se pueden **leer** las canciones de playlists propias (pero se puede **reproducir** cualquiera). Por eso la música por mood se basa en playlists que asigna el usuario o en búsquedas configurables.

### 5.1 Comportamiento normal: sugiere y tú aceptas
- Cuando cambia a un mood con `modo: "sugerir"`, o si no suena nada durante 15 min, muestra un bocadillo: *"¿Pongo algo alegre? 🎵"* con botones **[¡Sí!] [Ahora no]**. Mientras espera respuesta (30 s), se queda quieta.
- **Aceptar** → reproduce una de las playlists asignadas al mood (en aleatorio) o, si no hay ninguna, canciones buscadas con las palabras de `musica.busqueda` del mood. Sube Cariño y Diversión, y puede soltar un objeto.
- **Rechazar** → baja un poco Cariño; 3 rechazos seguidos suben Mosqueo.
- Cooldown entre sugerencias: 20 min. Todo configurable en `config/music.json`.
- Las playlists de cada mood se asignan en la ventana de Música (con botón ▶ Probar).
- En el chat también podrás pedirle: *"ponme algo tranquilo"* (fase 3).

### 5.2 Gustos musicales
- Sus **artistas favoritos y odiados los define el usuario** en `config/music.json`.
- Suena un favorito → baila (animación `dance`), lo comenta y sube Diversión.
- Suena uno odiado → gruñe y sube un poco el Mosqueo.
- **Saltar una canción que puso ella** → sube Mosqueo. Cambiar a otra música mientras suena la suya → se mosquea un poco.
- El panel de Estado muestra lo que suena, si lo ha puesto ella y su opinión.
- El LLM podrá opinar sobre la canción que suena (fase 3).
- **Baile al ritmo:** escucha el sonido del PC (cualquier programa: Spotify, YouTube...) en una ventana oculta y saca el ritmo en local. Solo analiza en memoria cuánto cambia cada frecuencia; no graba ni guarda nada. No escucha en los modos seguros (pantalla completa, llamada, No molestar) ni si no estás delante.
  - Detección: "novedad" del espectro (sobre todo bombo y bajo) → tempo por autocorrelación de los últimos 8 s (70–180 BPM, con preferencia por los tempos habituales para no irse al doble o la mitad) → fase alineando los golpes. Avisa de cada golpe predicho, así que sigue el ritmo aunque algún golpe no se oiga. Necesita unos 4 s de música para engancharse.
  - **Baila sola a ratos** si suena música con ritmo y no está cabreada: cada 4–10 minutos, durante 20–40 s (`config/music.json` → `baile`). Sube un poco la Diversión.
  - **Se le puede pedir** que baile en el chat (*"¡baila!"*) o en el menú (Jugar → ¡Baila!). Solo baila si no está cabreada y si suena algo; si no, lo dice.
  - Mientras baila (también cuando suena un artista favorito) da un saltito en cada golpe y se da la vuelta cada 4. El saltito lo pone el juego, así que funciona con cualquier skin.

### 5.3 Travesuras musicales (solo en mood con `modo: "travesura"`)
- Pausar la música.
- Saltar la canción que estás escuchando.
- Secuestrar la música: pone canciones spooky que **busca ella sola** (búsquedas editables en `config/music.json`; no crea ni modifica nada en tu cuenta).
- Llenarte la cola con canciones spooky.
- Pausar, saltar y la cola solo ocurren si estás escuchando algo; si no suena nada, lo que hace es poner su música.
- **Solo si estás delante:** las travesuras y las sugerencias de música solo ocurren si has usado el ratón o el teclado en los últimos 5 minutos (`soloSiActivoMinutos` en `config/music.json`). Si te vas, se cabrea igual, pero te espera. Tampoco gasta la IA en comentarios espontáneos mientras no estás.
- Animación `mischief` (risa de diablillo).

Reglas:
- **Máximo 1 travesura cada 10 minutos** (musical o de escritorio, cuentan juntas; configurable).
- Siempre la anuncia con una animación o una risa, para que sepas que ha sido ella.
- Se le pasa cuidándola.

### 5.4 Travesura de bienvenida 😈
Si cerraste el programa con ella cabreada, al volver a abrirlo **te recibe con una travesura** a los 5–10 segundos, con un bocadillo tipo *"¿Ahora vuelves?"*. Si al abrir estás en un modo seguro (juego, llamada…), espera a que termine. Esta travesura no tiene que esperar al cooldown de 10 minutos, pero sí lo reinicia (para que no lleguen dos seguidas).

---

## 6. Interacción y drops

### 6.1 Formas de jugar
| Tipo | Ejemplos | Afecta |
|---|---|---|
| **Ratón** | Acariciar (pasar el cursor por encima), cosquillas (clics), cogerla y lanzarla | Cariño, Diversión (lanzarla mucho → Mosqueo) |
| **Juguetes físicos** | Lanzar una pelota por el escritorio y te la trae; puntero láser que persigue | Diversión |
| **Minijuegos** | Piedra-papel-tijera, adivina la canción, escondite (ver 6.4) | Diversión, Cariño |
| **Chat** | Adivinanzas, trivia musical, historias (vía LLM) | Diversión, Cariño |

### 6.2 Drops
- Cada actividad tiene una **tabla de botín** (`config/loot.json`) con probabilidad y rareza (común / rara / épica).
- La probabilidad de drop mejora con buen mood y Afinidad alta.
- **Rendimientos decrecientes**: repetir la misma actividad sin parar da menos drops (y la aburre).
- Los objetos caen al lado de la mascota y se recogen con clic → inventario.

| Actividad | Qué suele soltar |
|---|---|
| Caricias | Comida y bebida comunes |
| Cosquillas | Bebidas comunes, a veces un Refresco burbujeante |
| Lanzar la pelota / láser | Juguetes, Refresco burbujeante |
| Ganar un minijuego | Objetos raros, con probabilidad de uno épico |
| Perder un minijuego | Un objeto común de consolación (si se lo ha pasado bien) |
| Juegos de chat | Especiales (Carta de disculpa, Té de tila) |
| Aceptar su sugerencia musical | Probabilidad de Vinilo misterioso |

**Inventario inicial:** 3 Galletas, 3 Aguas y 1 Pelota.

**Para no bloquearse cuando está cabreada:** siempre acepta comida y bebida, las caricias funcionan a veces (no siempre huye) y bajan algo el Mosqueo, y sus drops cambian a objetos de reconciliación (Chuche de la paz, Té de tila).

### 6.3 Objetos (`config/items.json`)
- Inventario de **20 huecos**, con objetos apilables (máx. 10 por hueco).
- Se le dan arrastrando el objeto hasta la mascota o desde el inventario.
- Al crear la mascota se eligen al azar **2 objetos favoritos** (efecto ×1,5 y reacción especial) y **1 odiado** (la mitad de efecto, +5 Mosqueo y cara de asco). Se pueden ver y editar en el guardado.
- Los gráficos de los objetos también forman parte de la skin (`skins/<skin>/items/<id>.png`).

**Comida (Hambre)**
| Objeto | Rareza | Efecto |
|---|---|---|
| Galleta | Común | Hambre +15 |
| Manzana | Común | Hambre +20 |
| Onigiri | Común | Hambre +30 |
| Pizza | Rara | Hambre +45, Diversión +10 |
| Tarta | Rara | Hambre +40, Cariño +15 |
| Ramen picante | Rara | Hambre +50, Mosqueo +5 (se pone gruñona un rato 🌶️) |
| Banquete | Épica | Hambre al 100, Cariño +20 |

**Bebida (Sed)**
| Objeto | Rareza | Efecto |
|---|---|---|
| Agua | Común | Sed +25 |
| Zumo | Común | Sed +30, Diversión +5 |
| Batido | Rara | Sed +40, Cariño +10 |
| Refresco burbujeante | Rara | Sed +35, Diversión +15 (eructito incluido) |
| Té de tila | Rara | Sed +30, Mosqueo −15 |
| Elixir arcoíris | Épica | Sed al 100, Diversión +20 |

**Juguetes (Diversión)**
| Objeto | Rareza | Efecto |
|---|---|---|
| Pelota | Común | 5 usos. La lanzas por el escritorio y te la trae: Diversión +10 por lanzamiento |
| Puntero láser | Raro | 10 usos. Persigue el cursor durante 30 s: Diversión +20 |
| Peluche | Raro | Permanente. Se lo das y lo abraza un rato: Cariño +15 (una vez cada hora) |
| Auriculares mini | Épico | Permanente. Se los pone y baila con la música: la Diversión no baja mientras suene algo que le gusta (30 min) |

**Especiales**
| Objeto | Rareza | Efecto |
|---|---|---|
| Chuche de la paz | Rara | Mosqueo −40 |
| Carta de disculpa | Rara | Mosqueo −25, Cariño +10 (la lee en voz alta en un bocadillo, con drama) |
| Vinilo misterioso | Épica | Te regala una canción que le gusta (la añade a la cola) y sube su Afinidad +5 |
| Reloj de arena | Épica | Congela la bajada de stats durante 30 min |

### 6.4 Minijuegos

Todos se lanzan desde el menú de clic derecho → **Jugar**. No están disponibles en modo seguro. Las preguntas usan botones en su bocadillo; si no respondes en el tiempo dado, lo deja ("¿Ya no juegas?"). Recompensas en `config/stats.json` → `minijuegos`.

**Juguetes físicos** (al usarlos desde el inventario; la recompensa llega al terminar de jugar)
- **Pelota**: aparece a sus pies; la coges y la lanzas (con física y rebotes). Ella corre, la recoge, la trae sobre la cabeza hasta donde la lanzaste y la suelta: Diversión +10.
- **Láser**: 30 s con un punto rojo que sigue a tu cursor; ella lo persigue: Diversión +20.

**Piedra, papel o tijera**
- Al mejor de 3 (máx. 5 rondas; empate final = tablas). Tiene una jugada favorita que repite más.
- Si está mosqueada (mosqueo ≥ 40), a veces (35 %) **hace trampa**: enseña su jugada y luego "…digo ¡Papel! 😏". Si le haces clic en esos 2 segundos, la pillas y ganas la ronda.
- Ganar → drop de la tabla `minijuegoGanado`. Perder → se regodea y le sube la Diversión.

**Adivina la canción** (requiere Spotify)
- Canciones de **tus playlists propias** (Spotify solo deja leer las canciones de playlists tuyas) y de sus artistas favoritos.
- Cada ronda: suena 10 s desde un punto aleatorio, se pausa y salen **4 opciones** (en columna) durante 15 s. 3 rondas.
- Va de buena fe: no mires la app de Spotify 😉.
- Al acabar, **vuelve a dejar lo que estabas escuchando** (canción, posición y si estaba en pausa). Mientras dura, la música no reacciona a gustos ni hace sugerencias.
- 3/3 → premio de minijuego ganado; 0/3 → se ríe de ti.

**Escondite**
- "¡Cuenta hasta 10!", desaparece y se esconde en un monitor al azar: **asomando media cara por el borde izquierdo o derecho**, o **detrás de la barra de tareas** (solo asoman la antena y los ojos; lo de debajo del suelo no se ve ni se puede pulsar). Animación `hide_peek`.
- Escondida no habla ni suena (no se delata).
- Tienes **60 segundos**. Junto al cursor salen pistas: *"Frío, frío ❄️ … ¡Caliente! 🔥 … ¡¡Que te quemas!!"*, o "prueba en otra pantalla".
- La encuentras (clic) → premio. Se acaba el tiempo → sale riéndose.

**Juegos por chat**
- **Adivinanzas** y **trivia musical**: la pregunta sale de una **lista fija** (traducida, en `locales/*.json`) y **el acierto lo comprueba el juego** comparando con las respuestas válidas. La IA solo reacciona en personaje (sabe la respuesta y si has acertado: felicita o da una pista sin destriparla). Los modelos pequeños se inventaban preguntas sin sentido, por eso no las generan. 3 intentos (adivinanzas) o 2 (trivia). Sin IA funcionan igual, con frases fijas.
- **Historia por turnos**: libre con la IA (necesita Ollama); termina a los 6 turnos tuyos.
- Ganar → premio de la tabla `juegoChat`.

---

## 7. Mascota en el escritorio

### 7.1 Movimiento (mixto, multi-monitor)
- **Multi-monitor**: puede pasear entre pantallas cruzando los bordes donde los monitores están contiguos (según su disposición en Windows). También se la puede arrastrar de una pantalla a otra.
- Tiene una **zona "casa"** (por defecto, una esquina sobre la barra de tareas del monitor principal; configurable, puede estar en cualquier monitor).
- Sale a pasear de vez en cuando según su mood (`exploracion`): feliz → explora más, triste → se queda en casa.
- Camina por la barra de tareas y **trepa a las ventanas**: paseando (sin estar cabreada), a veces va hasta una ventana cercana, **trepa por el lateral** (animación `climb`), se sube de un saltito y pasea por encima de la barra de título un rato (20–60 s), y luego salta al suelo. Elige ventanas que no estén maximizadas, que tengan sitio por encima y cuyo borde de arriba no tape otra ventana. Si la mueves, la minimizas o la tapas con otra, se cae (y se queja). Lo hace más cuanto más exploradora sea su mood (`config/stats.json` → `trepar`). "¡A casa!" o darle un juguete la bajan.
- Se puede arrastrar y lanzar con el ratón (tiene física sencilla: cae, rebota).
- Botón/menú **"¡A casa!"** para mandarla de vuelta.

### 7.1b Acercarse a la pantalla ("¿estás ahí?")
Se gira de frente, avanza hacia el centro de la pantalla haciéndose grande (unas 5-6 veces, 1,6 s), con el fondo un poco oscurecido por los bordes, y **toca el cristal** con las manitas ("toc, toc"), dejando marcas de vaho que se desvanecen. Pregunta en un bocadillo y espera unos 8 s; luego vuelve a su sitio haciéndose pequeña. Mientras está en grande solo su cuerpo recoge los clics (el resto de la pantalla sigue funcionando) y no se la puede arrastrar. Nunca en los modos seguros. Configuración en `config/stats.json` → `tocarPantalla`.
- **"¿Estás ahí?":** si llevas 3-10 minutos sin tocar el ratón ni el teclado (una vez por rato). Si lo mueves o le haces clic, "¡Ah, estás ahí!" y le sube el Cariño. Si no, vuelve sin decir nada (no había nadie).
- **Se siente ignorada:** si estás usando el PC, tiene el Cariño bajo (< 30) y no le haces caso desde hace 15 minutos (tocarla, darle algo, hablarle o jugar). Si le haces clic, se alegra y sube el Cariño; si no, se queda triste y le sube un poco el Mosqueo.
- Como mucho una vez cada 60 minutos entre las dos.
- **Cabreada (travesura):** golpea el cristal ("¡¡EH!! ¡¡QUE ESTOY AQUÍ!!") con una animación roja y ondas de golpe. Entra en el sorteo de travesuras (`travesuras.pesos.golpear`). Si le haces clic, se le pasa un poquito el enfado.
- Animaciones: `front` (andando de frente), `knock` (tocando el cristal) y `knock_angry`. Como se ven en grande, conviene dibujarlas a más resolución (la skin provisional las tiene a 512 px con `"escala": 0.25`).

### 7.2 Travesuras de escritorio (cabreada)
Las travesuras de música y las de escritorio salen del mismo sorteo, con pesos en `config/stats.json` → `travesuras.pesos` (`musica`, `esconderse`, `sentarse`, `notita`, `golpear`: golpear el cristal, ver 7.1b). Si la elegida no se puede hacer (no hay Spotify, tu ventana está maximizada, ya hay 3 notitas...), prueba con otra. Cuentan juntas para el máximo de 1 cada 10 minutos, y la de bienvenida también puede ser de escritorio.
- **Esconderse:** avisa (*"¡A que no me encuentras!"*) y desaparece. Asoma media cara por un borde de la pantalla, por detrás de la barra de tareas o **por detrás de tu ventana activa** (por un lado o por encima, recortada para que parezca que está detrás). Si haces clic en ella o la acaricias, la has encontrado y se le pasa un poco el enfado (`encontrarlaMosqueo`). Si no, sale sola a los 3 minutos (`escondidaSegundos`) quejándose de que ni la has buscado. Si mueves o cierras la ventana tras la que estaba, sale protestando. Escondida no se puede arrastrar ni empezar un minijuego.
- **Sentarse encima de tu ventana:** aparece sobre la barra de título de la ventana que estás usando y pasea por encima. Si la mueves, la minimizas o cambias a otra ventana, se cae (y se queja). A los 45 s (`sentadaSegundos`) se baja sola. "¡A casa!" la baja de un salto y la manda a casa. No lo hace con ventanas maximizadas o demasiado arriba (no cabría).
- **Notitas pasivo-agresivas:** un post-it amarillo en el monitor que estás mirando, con un texto que escribe la IA según su estado (o una frase fija si no hay IA), firmado con su nombre. Se quita con un clic (a veces protesta). Máximo 3 a la vez (`maxNotitas`). Se guardan en la partida, así que siguen ahí si cierras el programa.
- **Huir del cursor:** cuando le acercas el ratón, a veces sale corriendo en dirección contraria (`huirDelCursor`, probabilidad por cada acercamiento). No cuenta como travesura (no gasta los 10 minutos), pero solo pasa cabreada y fuera de los modos seguros. No huye si te está preguntando algo o jugando con un juguete.

### 7.3 Modos seguros (no molesta ni toca la música)
- **Juego o app a pantalla completa** detectada: cada 1,5 s se mira si la ventana activa ocupa un monitor entero (o si Windows indica un juego D3D o modo presentación); tiene que durar 2 comprobaciones seguidas. La ventana de la mascota de ese monitor se oculta.
- **Llamada en curso**: algún programa está usando el micrófono (Windows lo anota en el registro, `CapabilityAccessManager\ConsentStore\microphone`; se mira cada 8 s). Programas que usan el micro sin ser llamadas (p. ej. OBS) se ignoran con `modosSeguros.ignorarMicrofono` en `config/stats.json`. En llamada la mascota sigue visible, solo calla.
- **"No molestar" manual** (menú clic derecho, con duración). Abusar de él sube Mosqueo.
- Se puede desactivar cada modo en `config/stats.json` → `modosSeguros`.
- El panel de Estado indica por qué está en silencio.

En modo seguro no hay bocadillos, ni sonidos, ni travesuras, ni cambios de música. Con varios monitores, si hay pantalla completa en un monitor, se va a otro monitor y se queda tranquila allí. Si no hay otro monitor libre, se esconde.

---

## 8. Comunicación

- **Clic** en la mascota → abre un chat pequeño junto a ella.
- **Bocadillos espontáneos**: avisa de hambre/sed, comenta la canción, sugiere música, se queja…
- **Menú con clic derecho**: Inventario · Jugar (juguetes/minijuegos) · No molestar · ¡A casa! · Ajustes · Salir.

### 8.1 Chat con IA local (Ollama)
- Modelo en local: **`qwen3:8b` por GPU** (~2 s por respuesta en una GTX 1070, cabe en 8 GB de VRAM). Elegido tras comparar qwen3:1.7b/4b/8b, llama3.2:3b y gemma3:4b con la misma conversación: es el más coherente y el que mejor recuerda lo que le cuentas. `gemma3:4b` tiene más personalidad pero olvida cosas; sin GPU, `qwen3:4b` (~15 s por CPU).
  - Se configura en Ajustes → IA o en `settings.json` (`ollama.model`, `ollama.useGpu`). Con la GPU desactivada usa `num_gpu: 0` (solo CPU).
  - Los modelos pequeños se inventan acciones que nadie ha pedido (p. ej. poner música al decir "hola"): un **filtro de intención** solo deja pasar una acción si el mensaje del usuario la pide con palabras reconocibles.
- El chat es una **ventanita aparte junto a la mascota** (la overlay no puede recibir teclado). Se abre con **un clic** en la mascota o con «Hablar» en el menú.
- El *prompt* del sistema se construye con: **personalidad base** + normas + **recuerdos**. Es la parte fija, para que Ollama la reaproveche en caché. Delante de cada mensaje va una línea de **estado** traducida a palabras: mood y su tono, cómo están sus necesidades, la relación (afinidad), la hora y la canción que suena.
- La respuesta es un **JSON estructurado** (Ollama *structured outputs*): `reply`, `action`, `value` y `emotion` (que elige la animación). Todo se valida.
- **Acciones desde el chat:** poner música de un mood o algo concreto («pon algo de Rihanna»), pausar, reanudar o pasar canción, abrir inventario o estado, ir a casa y «No molestar». Si está cabreada puede negarse.
- Hablar con ella sube un poco el **Cariño** (cada vez menos si no paras).
- **Bocadillos mixtos:** las reacciones rápidas (caricias, comer, travesuras...) son frases fijas para que sean instantáneas. Los comentarios espontáneos (necesidades, cómo se siente, la hora, recuerdos) los escribe la IA el 60 % de las veces, y a veces comenta la canción que empieza a sonar.
- **Sin Ollama** disponible → frases predefinidas y el chat avisa de que la IA no está disponible (el juego sigue funcionando).
- Ajustes → IA: activar o desactivar, elegir modelo (de los instalados), usar o no la GPU y olvidar recuerdos.

### 8.2 Personalidad
- `skins/<skin>/personality.md`: carácter base, editable (la skin provisional trae una **pícara y dramática**).
- La **Afinidad** la matiza: alta → más cariñosa; baja → más rencorosa.

### 8.3 Memoria
- `%APPDATA%/Melochi/memory.json`: los últimos mensajes del chat y una lista de **recuerdos** (frases cortas: tu nombre, tus gustos, promesas, bromas, cómo la tratas...).
- Cada 8 mensajes tuyos, o tras 3 minutos sin hablar, el LLM **actualiza los recuerdos** con lo nuevo (máx. 15). Si cierras antes, se resume en la siguiente sesión.
- Ajustes en `config/brain.json`.

---

### 8.4 Idiomas
- **Español e inglés.** La interfaz, los bocadillos predefinidos y las frases de respaldo sin Ollama están en archivos de traducción (`locales/es.json`, `locales/en.json`).
- El LLM responde en el idioma elegido en Ajustes.
- Los nombres de los moods y de los objetos en los archivos de configuración se pueden traducir (`"nombre": { "es": "Feliz", "en": "Happy" }`).

---

## 9. Sonidos
- Sonidos cortos por evento (`saludo`, `comer`, `beber`, `risa`, `grunido`, `travesura`, …) en la skin, editables.
- Volumen propio y opción de silenciar. Silencio automático en modos seguros.

---

## 10. Gráficos editables (skins)

Una skin es una carpeta con todo lo visual y sonoro de la mascota. Se **recarga en caliente** al guardar un archivo.

```
skins/
  mi-bicho/
    skin.json          ← definición de animaciones
    personality.md     ← personalidad base
    anims/
      idle/            ← frames sueltos: 000.png, 001.png…
      walk.png         ← o sprite sheet…
      walk.json        ← …con su JSON (formato Aseprite / TexturePacker)
    sounds/
      risa.ogg
```

Se aceptan **ambos formatos**: carpeta de PNGs por animación o sprite sheet + JSON.

```jsonc
// skin.json
{
  "nombre": "Mi bicho",
  "escala": 1.0,
  "ancla": [0.5, 1.0],                 // punto de apoyo (pies)
  "animaciones": {
    "idle":      { "frames": "anims/idle/", "fps": 8,  "loop": true },
    "walk":      { "sheet":  "anims/walk.json", "fps": 12, "loop": true },
    "feliz_idle":{ "frames": "anims/feliz_idle/", "fps": 10, "loop": true }
  },
  "sonidos": { "risa": ["sounds/risa.ogg"] }
}
```

**Resolución de animaciones**: se busca primero `<mood>_<acción>` y, si no existe, `<acción>`. Así puedes empezar solo con las básicas e ir añadiendo variantes por mood.

**Animaciones mínimas (MVP):** `idle`, `walk`, `drag` (cogida), `fall`, `eat`, `drink`, `happy` (reacción), `angry` (reacción), `talk`.
**Opcionales:** `dance`, `sleep`, `hide_peek`, `climb` (trepando, con la pared a su derecha; si falta, usa `walk`), `front`, `knock`, `knock_angry` (acercarse a la pantalla; conviene dibujarlas grandes y usar `"escala"` en la animación), `petted`, `mischief`, `cheat` (trampa en piedra-papel-tijera), y variantes por mood.

### 10.1 Skin provisional (`placeholder`)
Mientras el usuario dibuja la suya, el juego incluye una **skin provisional generada por script**. Es una "gota" de colores con ojos, y su color y expresión cambian según la animación. Usa **exactamente el mismo formato** que una skin de usuario, con frames PNG y una sprite sheet, así que sirve para probar el formato y como plantilla para copiar. Los objetos también tienen iconos provisionales sencillos.

---

## 11. Arranque y primera vez

- Se abre **manualmente** (no arranca con Windows). Al cerrarla, el tiempo de la mascota se congela.
- **Primera vez:**
  1. Elegir idioma y ponerle **nombre** a la mascota.
  2. **Conectar Spotify** (se puede saltar y hacer más tarde desde Ajustes).
- Las playlists de cada mood se asignan desde **Ajustes** (o editando `moods.json`).

---

## 12. Arquitectura técnica (propuesta)

**Stack recomendado: Electron + TypeScript + PixiJS**

| Necesidad | Solución |
|---|---|
| Overlay transparente, siempre encima, clic "a través" excepto sobre la mascota | Ventana Electron transparente sin marco + `setIgnoreMouseEvents(true, { forward: true })` con detección de píxel bajo el cursor |
| Multi-monitor | **Una ventana overlay por monitor** (evita problemas con distintos escalados/DPI). La mascota "se pasa" de una ventana a otra al cruzar el borde. |
| Animaciones 2D cartoon, sprite sheets | **PixiJS** (soporta nativamente JSON de Aseprite/TexturePacker) |
| Chat, inventario, menús | HTML/CSS en la propia overlay o ventanas pequeñas |
| Spotify | Web API + OAuth PKCE con redirección a `127.0.0.1` |
| IA local | API HTTP de Ollama (`localhost:11434`) |
| Ventanas, pantalla completa, micrófono en uso | Llamadas Win32 (vía `koffi`) + registro de Windows para uso del micrófono |
| Beat de la música | Captura loopback del audio del sistema (`getDisplayMedia` con `audio: 'loopback'` en una ventana oculta) + Web Audio `AnalyserNode` + detector propio (`src/shared/beat.ts`) |
| Guardado | JSON en `%APPDATA%/Melochi` |

¿Por qué Electron y no Tauri/Godot? Electron es lo más maduro para overlays con clic pasante selectivo en Windows, y facilita mucho la UI de chat, el OAuth de Spotify y las llamadas HTTP a Ollama. Coste: ~100–150 MB de RAM, aceptable para este caso.

**Módulos:**
`Overlay/Render` · `Pet (movimiento, física, animación)` · `Stats & Mood engine` · `Inventory & Loot` · `Music (Spotify + gustos + travesuras)` · `Brain (Ollama, prompts, memoria)` · `SafeMode (pantalla completa, llamadas, DND)` · `Skins (carga + hot reload)` · `Save`

---

## 13. Fases de desarrollo (propuesta)

1. **F1 — Mascota viva**: overlay multi-monitor, skin con hot reload, idle/walk/drag/fall, zona casa, stats + guardado, menú clic derecho, inventario, drops por caricias, moods `neutral`/`feliz`/`cabreada`, nombre en el primer arranque, i18n es/en.
2. **F2 — Spotify**: login, playlists por mood, sugerencias con aceptar/rechazar, travesuras musicales, gustos básicos.
3. **F3 — Cerebro**: chat con Ollama, bocadillos espontáneos, personalidad, memoria, acciones desde el chat.
4. **F4 — Juego completo**: juguetes físicos, minijuegos, travesuras de escritorio, notitas, modos seguros, baile al ritmo, subirse a ventanas.

---

## 14. Preguntas abiertas

_Ninguna bloqueante. El resto se ajustará probando (velocidades de las stats, probabilidades de drop, valores de los objetos)._

### Decisiones cerradas (v0.3)
- Gráficos provisionales generados por script; el usuario hará los definitivos.
- Catálogo de objetos y minijuegos propuestos en las secciones 6.3 y 6.4.
- Máximo 1 travesura cada 10 minutos.
- Travesura de bienvenida si cerraste el programa con ella cabreada.

### Decisiones cerradas (v0.2)
- Multi-monitor: sí, puede pasear entre pantallas.
- Las stats bajan aunque estés ausente (con el programa abierto).
- Tarda ~2 h en cabrearse si la ignoras por completo.
- Hardware: producción con RTX 4060 Ti (8 GB); desarrollo solo con CPU.
- No arranca con Windows; se abre manualmente.
- Primera vez: solo nombre + conectar Spotify.
- Afinidad visible.
- Idiomas: español e inglés.

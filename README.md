# Melochi

Mascota de escritorio tipo Tamagotchi para Windows. El diseño completo está en [docs/GDD.md](docs/GDD.md).

**Estado:** fases 1 (mascota viva), 2 (Spotify) y 3 (chat con IA local). Los minijuegos llegan en la fase 4.

## IA local (chat)

La mascota habla con un modelo de lenguaje local a través de [Ollama](https://ollama.com). Instálalo y descarga un modelo, por ejemplo:

```bash
ollama pull qwen3:8b
```

Modelos probados (con una GTX 1070 y driver reciente):

| Modelo | Respuesta (GPU) | Notas |
|---|---|---|
| `qwen3:8b` (por defecto) | ~2 s | El más coherente y el que mejor usa lo que le cuentas. 5,2 GB. |
| `gemma3:4b` | ~2 s | Más dramática y con más personalidad, pero olvida cosas. Por CPU, ~25 s. |
| `qwen3:4b` | ~2 s | Correcto. Por CPU, ~15 s (la mejor opción sin GPU). |

Necesita un driver de NVIDIA reciente: con uno antiguo, Ollama falla al cargar los modelos en la GPU. En el menú de la mascota, **Ajustes → IA** permite elegir el modelo, usar o no la tarjeta gráfica y borrar sus recuerdos. Su personalidad está en `skins/<skin>/personality.md`.

## Conectar Spotify

Necesitas Spotify Premium. En el menú de la mascota: **Ajustes → Música…**, y sigue los pasos:

1. Crea una app en el [panel de desarrolladores de Spotify](https://developer.spotify.com/dashboard).
2. Añade la Redirect URI `http://127.0.0.1:8977/callback` y marca «Web API».
3. Copia el Client ID en la ventana de Música y pulsa «Conectar con Spotify».

Después asigna playlists a cada estado de ánimo en esa misma ventana. Los artistas que le gustan y los que odia se editan en `config/music.json`.

## Requisitos

- Windows 10/11
- Node.js 22.12 o superior (recomendado: 24 LTS)

## Arrancar

```bash
npm install
npm run dev
```

`npm run dev` compila y abre el juego. La primera vez te pide idioma y nombre para la mascota.

Otros comandos:

| Comando | Qué hace |
|---|---|
| `npm run build` | Compila a `dist/` |
| `npm start` | Abre el juego ya compilado |
| `npm run watch` | Recompila al guardar (luego cierra y vuelve a abrir el juego) |
| `npm run typecheck` | Comprueba los tipos de TypeScript |
| `npm run gen:placeholder` | Regenera la skin provisional |

## Cómo se juega

- **Varios clics rápidos**: cosquillas.
- **Pasa el cursor de lado a lado** por encima: caricias.
- **Arrástrala** y suéltala con impulso para lanzarla (sin pasarte, que se marea).
- **Clic**: te saluda y abre el chat.
- **Clic derecho**: hablar, inventario, estado, "No molestar", mandarla a casa, ajustes.
- Al jugar con ella **suelta objetos**: haz clic en ellos para recogerlos y dáselos desde el inventario (clic o arrastrando hasta ella).
- También hay un icono en la bandeja del sistema con el mismo menú.

## Personalizar

En desarrollo, todo se lee directamente de las carpetas del proyecto y se recarga al guardar:

| Carpeta | Contenido |
|---|---|
| `skins/<nombre>/` | Gráficos y sonidos. Copia `skins/placeholder` como plantilla; `skin.json` explica el formato. |
| `config/stats.json` | Velocidad a la que bajan las necesidades, efectos de cada interacción, mosqueo y afinidad. |
| `config/moods.json` | Estados de ánimo: condiciones, animaciones, comportamiento (y en la fase 2, playlists). |
| `config/items.json` | Objetos y sus efectos. |
| `config/loot.json` | Qué objetos suelta con cada actividad. |
| `config/brain.json` | Chat con IA: memoria, cuánto escribe la IA en los bocadillos, efectos de hablar con ella. |
| `config/music.json` | Sus artistas favoritos y odiados, búsquedas de su música de travesura, tiempos de las sugerencias y efectos en sus stats. |
| `locales/es.json`, `locales/en.json` | Textos y frases de los bocadillos. |

### Formato de las skins

Cada animación puede ser una **carpeta de PNG numerados** o una **sprite sheet** exportada desde Aseprite o TexturePacker (JSON en formato hash o array, sin rotación). Las variantes por mood se llaman `<mood>_<animación>` (por ejemplo `feliz_idle`); si no existen, se usa la genérica. La skin provisional incluye ejemplos de los tres casos.

Animaciones que usa el juego: `idle`, `walk`, `drag`, `fall`, `eat`, `drink`, `happy`, `angry`, `talk`, `petted`, `dance`, `mischief`. Solo `idle` es obligatoria: el resto, si faltan, se sustituyen por la más parecida.

Los iconos de los objetos van en `skins/<nombre>/items/<id>.png`.

La partida se guarda en `%APPDATA%/Melochi/save.json` (borra ese archivo para empezar con una mascota nueva).

## Pruebas

Para probar sin tocar tu partida, usa otra carpeta de datos y activa los depuradores:

```bash
MELOCHI_USER_DATA=/ruta/a/partida-de-prueba ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9333 --inspect=9334
```

En `tools/` hay scripts que se conectan a esos puertos:

| Script | Qué hace |
|---|---|
| `tools/cdp.mjs` | Lista ventanas, evalúa código, hace capturas y muestra la consola del renderer (`main` = proceso principal en el puerto 9334). |
| `tools/interact.mjs` | Simula toques, cosquillas, caricias, abrir paneles, dar objetos y recoger drops. |
| `tools/realmouse.mjs` | Prueba con el ratón real de Windows: clic a través, arrastrar, lanzar y menú contextual. Mueve tu cursor. |
| `tools/exstyle.mjs` | Muestra si la ventana deja pasar el ratón (`WS_EX_TRANSPARENT`). |
| `tools/music.mjs` | Prueba Spotify: sugerencias, saltar su canción, travesuras, gustos y el Vinilo misterioso. **Pone música de verdad.** |
| `tools/chat.mjs` | Prueba el chat con IA: enviar mensajes, bocadillos, recuerdos y comparar modelos (con tiempos). |
| `tools/safe.mjs` | Vigila los modos seguros (pantalla completa, llamada) y qué ventanas están visibles. |
| `tools/fullscreen-test/` | Abre una ventana a pantalla completa unos segundos (como un juego): `electron.exe tools/fullscreen-test 12`. |
| `tools/mic-test/` | Usa el micrófono unos segundos sin grabar nada, para probar la detección de llamadas. |
| `tools/watch.mjs` | Vigila durante N segundos los cambios de mood, bocadillos y canción (opcionalmente tras ejecutar algo en main). |

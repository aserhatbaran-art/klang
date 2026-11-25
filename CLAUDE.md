# Klang – Audioplayer-PWA
Zweck: Schlanker, installierbarer Offline-Audioplayer (Ordner, Wiedergabe, Schlaftimer) für Android/Desktop, Vanilla JS ohne Abhängigkeiten.

## Befehle
- Starten: `python -m http.server 8123 --bind 127.0.0.1` → http://localhost:8123 (auch als `klang` in `.claude/launch.json`)
- Syntaxprüfung: `node --check app.js` und `node --check sw.js`
- Kein Build, keine Tests, kein Linter, kein Paketmanager.

## Struktur
- `index.html`: Markup, SVG-Icon-Sprite (`#i-*`), strenge CSP (kein Inline-Script/-Style)
- `styles.css`: Design-Tokens in `:root` (Dark/Light per `prefers-color-scheme`), ab 960 px Player als Seitenleiste
- `app.js`: gesamte Logik (IndexedDB, Ordner/Import, Wiedergabe, Media Session, Schlaftimer, Sheets, Zurück-Taste)
- `sw.js`: Service Worker, cache-first, App-Hülle vorab gecacht
- `manifest.webmanifest`, `icons/`: PWA-Installierbarkeit (PNG 192/512 + maskable + SVG)

## Konventionen
- UI-Texte und Kommentare auf Deutsch.
- DOM nur über Helfer `h()`/`icon()` mit `textContent` aufbauen, nie `innerHTML` (Dateinamen sind Nutzereingaben).
- Styles per CSSOM (`el.style.setProperty`) – Inline-`style`-Attribute verbietet die CSP.
- IndexedDB `klang` v1: Stores `folders`, `tracks` (Index `folderId`), `blobs` (Key = Track-ID), `kv` (`state`).
- Overlays (Ordneransicht, Player, Sheets) laufen über `pushLayer`/`closeTop` (history.pushState), damit die Android-Zurück-Taste funktioniert. Neue Overlays genauso einbinden.

## Achtung
- Nach jeder Dateiänderung `VERSION` in `sw.js` erhöhen, sonst liefert der Cache die alte Version.
- Installation auf Android braucht HTTPS-Hosting (GitHub Pages, Netlify o. Ä.); localhost reicht nur zum Testen am PC.
- Schema-Änderungen an IndexedDB nur mit Versionssprung und Migration in `onupgradeneeded`.
- Icons werden per Python-Skript erzeugt (lag im Scratchpad, nicht im Projekt); bei Änderungen `icons/icon.svg` als Vorlage nutzen.
- Hintergrundwiedergabe/Timer bei gesperrtem Android-Bildschirm nur am echten Gerät prüfbar.

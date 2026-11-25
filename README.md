# Klang – Audioplayer (PWA)

Schlanker Offline-Audioplayer ohne Abhängigkeiten und ohne Build-Schritt.

## Funktionen
- **Ordner**: anlegen, umbenennen, löschen; Ordner vom Gerät importieren (Unterordner werden eigene Ordner); Dateien hinzufügen, Titel umbenennen, verschieben, entfernen.
- **Abspielen**: Play/Pause, vor/zurück, ±15/30 s, Zufall, Wiederholen (Ordner/Titel), Tempo 0,75–2×, Sperrbildschirm-Steuerung (Media Session), Position wird gemerkt.
- **Schlaftimer**: 5–90 Min. oder „Ende des Titels“, +5 Min., sanftes Ausblenden in den letzten 15 s.
- **Offline**: App-Hülle per Service Worker, Audiodateien in IndexedDB (Kopie in der App; Originale bleiben unverändert).

## Lokal starten
```powershell
python -m http.server 8123 --bind 127.0.0.1
```
Dann http://localhost:8123 öffnen.

## Auf Android installieren
Eine PWA braucht **HTTPS**. Den Ordner auf einen statischen Host legen, z. B. GitHub Pages, Netlify oder Cloudflare Pages (nur die Dateien hochladen, kein Build). Dann in Chrome auf Android öffnen → Menü ⋮ → **App installieren** / **Zum Startbildschirm hinzufügen**.

## Hinweise
- Nach Änderungen an Dateien in `sw.js` die `VERSION` erhöhen, sonst liefert der Cache die alte Version aus.
- Speicher: Chrome erlaubt einer Website bis zu ca. 60 % des gesamten Gerätespeichers (abhängig vom freien Platz). Die App fordert beim ersten Import dauerhaften Speicher an, damit Android ihn nicht automatisch räumt.
- Wird die App-Website im Browser „Daten löschen“, sind auch die importierten Titel weg.

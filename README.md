# SprintLab

Sprint-Analyse aus 240-fps-Seitenaufnahmen, läuft als Web-App auf dem iPhone (kein App Store, keine Kosten).
Misst pro Lauf: **Bodenkontaktzeit, Flugzeit, Schrittlänge, Schrittfrequenz** und – wenn es sauber geht – die **Geschwindigkeit auf 6–8 m**. Sessions mit mehreren Athleten und Läufen, Übersicht, CSV-Export.

## Auf GitHub und aufs iPhone
1. Neues Repository anlegen und **alle Dateien** aus diesem Ordner hochladen (Add file → Upload files). Die Dateien liegen bewusst flach, ohne Unterordner.
2. Repository → Settings → Pages → Branch `main`, Ordner `/ (root)` → Save.
3. Nach 1–2 Minuten: `https://<dein-name>.github.io/<repo>/` in **Safari** öffnen.
4. Teilen-Symbol → **Zum Home-Bildschirm**. Danach läuft sie wie eine App, auch offline.

## Aufnahme
- iPhone auf Stativ, **fest**, Blick **senkrecht** zur Bahn, Kamera-Modus Zeitlupe 240 fps.
- Hütchen im Abstand 1 m auf der kameraseitigen Bahnlinie. Abstand Kamera → Linie messen und in der App eintragen.
- Video am besten über die Dateien-App laden (Originalqualität); aus der Fotomediathek kann iOS umrechnen.

## Auswertung (halbautomatisch)
1. **Hütchen**: Fußpunkte antippen, Maße eintragen. Die App rechnet die Perspektive der Läuferebene (Kamera-Abstand + Linie→Läufer) ein.
2. **Kontakte**: Zum ersten Bild mit Bodenkontakt springen, Fußpunkt antippen; zum letzten Kontaktbild springen, „Ende“ drücken. Pinch = Zoom.
3. **Ergebnis**: Werte pro Kontakt und Mittelwerte.

Genauigkeit: ein Bild = 4,17 ms. Bodenkontakt = (letztes − erstes Kontaktbild + 1) / 240; Flugzeit = Lücke zwischen zwei Kontakten. Geschwindigkeit = Strecke zwischen zwei Fußaufsätzen (6–8 m) / Zeit; nur „belastbar“ bei ≥ 3 Hütchen mit ≤ 3 cm Abweichung und ≥ 3 Schritten, sonst mit ⚠.

## Entwicklung
`node calc.test.mjs` prüft den Rechenkern. Daten liegen lokal im Browser (localStorage); Backup-Funktion auf der Startseite.

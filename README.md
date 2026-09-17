# Nästa lektion

Netlify-app som läser Skola24 och visar aktuell lektion samt nästa lektion.

## Netlify

Build settings:
- Publish directory: `.`
- Functions directory: `netlify/functions`

Environment variables:
- `SKOLA24_HOST` = `nyaskolan.skola24.se`
- `SKOLA24_SCHOOL` = `Nya Skolan Pettersberg`
- `SKOLA24_TEACHER` = `chba`

Efter deploy kan funktionen testas på:
`/.netlify/functions/schedule`

Projektet är i diagnostikläge tills Skola24s klassidentifierare är verifierad. Målet är att `Nästa lektion` ska avse nästa lektion för klassen som läraren just nu undervisar, inte lärarens egen nästa lektion.

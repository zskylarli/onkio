# Onkio

A client-side web app that turns a music collection export into a navigable 2D
map, built primarily for constructing DJ sets by walking a path through the
map. It reads a **rekordbox collection XML** (preferred) or an Apple Music xml file.

## Quick start

```bash
npm install
npm run dev     # development server at http://localhost:5173
npm test        # vitest suite (351 tests incl. full-scale pipeline)
npm run build   # type-check + production build to dist/
npm run preview # preview production build at http://localhost:4173
```

Open the app and drop a collection XML on the sidebar. The format is detected
from the file, and the map renders immediately from parse-time data.
# StockSense

This repository contains the portfolio frontend and the StockSense backend.

## Backend

The persistent inventory API is in [`backend/`](./backend/).

```powershell
cd backend
Copy-Item .env.example .env
npm install
npm start
```

The API uses SQLite and creates `backend/data/stocksense.db` automatically.
See [`backend/README.md`](./backend/README.md) for authentication and inventory endpoint details.

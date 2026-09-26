# StockSense Backend

Persistent REST API for the StockSense inventory system.

## Run locally

```powershell
cd backend
Copy-Item .env.example .env
npm install
npm start
```

The API runs at `http://localhost:4000`.

## Main endpoints

- `GET /api/health`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/request-reset`
- `POST /api/auth/reset-password`
- `GET /api/dashboard`
- `GET/POST /api/products`
- `GET /api/warehouses`
- `GET /api/stock`
- `GET /api/operations`
- `POST /api/operations/receipts`
- `POST /api/operations/deliveries`
- `POST /api/operations/transfers`
- `POST /api/operations/adjustments`
- `POST /api/operations/:id/validate`
- `GET /api/ledger`

All inventory routes require `Authorization: Bearer <token>`.
SQLite is created automatically at `backend/data/stocksense.db`.

## Example signup

```powershell
Invoke-RestMethod http://localhost:4000/api/auth/signup -Method Post -ContentType "application/json" -Body '{"name":"John Doe","email":"john@example.com","password":"password123"}'
```

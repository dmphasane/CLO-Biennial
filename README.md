# NEDLO Biennial 2027 – Stokvel Fund Reconciliation Tool (Cloud Edition)

Secure, multi-user, cloud-hosted version of the Stokvel Fund reconciliation tool.

## Stack
- **Node.js / Express** — REST API
- **PostgreSQL** — data store (members, entries, aliases, audit log)
- **Cloudinary** — file/media storage (logo, PDF exports, statement archives)
- **JWT + bcrypt** — authentication
- **Render** — hosting (web service + database)

## Local development
```bash
npm install
cp .env.example .env      # fill in your values
npm run initdb            # create tables + seed users (needs a real DATABASE_URL)
npm start                 # http://localhost:3000
```

## Folder structure
```
nedlo-server/
├── server.js          # Express API + static file server
├── db.js              # Postgres connection pool
├── schema.sql         # database tables
├── initdb.js          # schema + user seeding
├── render.yaml        # Render blueprint
├── DEPLOYMENT.md      # full step-by-step deployment guide
└── public/            # the frontend (served at /)
    ├── index.html         # management portal
    ├── register.html      # admin registration form
    ├── register-remote.html
    ├── api-adapter.js     # connects frontend to the API
    └── logo.png
```

## Deployment
See **DEPLOYMENT.md** for the complete Render + Cloudinary setup.

## API endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/login | — | Authenticate, returns JWT |
| POST | /api/register | — | Public member self-registration |
| GET | /api/members | ✓ | List members |
| POST | /api/members | ✓ | Create/update member |
| DELETE | /api/members/:id | ✓ | Delete member |
| GET | /api/entries | ✓ | List bank entries |
| POST | /api/entries/bulk | ✓ | Bulk save entries |
| DELETE | /api/entries | ✓ | Clear all entries |
| GET | /api/aliases | ✓ | Learned reference aliases |
| POST | /api/aliases | ✓ | Save an alias |
| GET | /api/audit | ✓ | Audit log |
| GET | /api/cloudinary/signature | ✓ | Signed upload params for Cloudinary |
| GET | /api/health | — | Health check |

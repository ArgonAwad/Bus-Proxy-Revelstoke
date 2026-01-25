# Bus-Proxy-Revelstoke
A simple real-time bus tracker map for Revelstoke, BC, using OpenLayers on the frontend and GTFS-Realtime data from BC Transit via a Node.js backend.

---

## 📦 Features

- Real-time vehicle positions using GTFS-Realtime feed
- Interactive map with route-colored icons
- Auto-refreshes every 30 seconds
- OpenLayers for map rendering
- Node.js backend with GTFS decoding via protobuf

---

## 🚀 Live Demo

[bus-tracker-Revelstoke.netlify.app](https://bus-tracker-Revelstoke.netlify.app/)
Deployed via [Netlify](https://www.netlify.com/)
Backend hosted on [Railway](https://railway.app)

---

## 🧩 Tech Stack

- Frontend: HTML, JS, OpenLayers
- Backend: Node.js, Express, node-fetch, protobufjs

---

## 🛠 Setup Instructions

### 1. Clone the repo
```bash
git clone https://github.com/gala-kapralova/Bus-Tracker-Revelstoke.git
cd bus-tracker-Revelstoke
```

### 2. Install backend dependencies
```bash
npm install
```

### 3. Start the backend
```bash
node server.js
```
Runs on `http://localhost:3000`

### 4. Open `index.html`
You can open it directly or use Live Server extension in VS Code.

---

## 🔒 License

### GTFS Realtime Proto
The protobuf schema is licensed under the [Apache 2.0 License](https://www.apache.org/licenses/LICENSE-2.0)

### BC Transit GTFS Feed
See [BC Transit Open Data Terms of Use](https://www.bctransit.com/open-data/) you must read and respect the [Terms of Use] (https://www.bctransit.com/open-data/terms-of-use/) before using the data which is presented free-of-charge and as is.


### This Project
MIT License. See `LICENSE` file.

---

## 📬 Contact

This project was created as an educational and volunteer initiative.

Maintainer: Gala @ Surfing Kinetics

Feel free to fork, use, and contribute!

---



import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import protobuf from 'protobufjs';

const app = express();
app.use(cors());

// URL of the GTFS-Realtime protobuf schema
const GTFS_PROTO_URL = 'https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto';
// URL to fetch real-time vehicle updates for Revelstoke from BC Transit
const GTFS_FEED_URL = 'https://bct.tmix.se/gtfs-realtime/vehicleupdates.pb?operatorIds=36'; // Revelstoke

let root = null;

// Load and parse the GTFS .proto schema
async function loadProto() {
  const response = await fetch(GTFS_PROTO_URL);
  const protoText = await response.text();
  root = protobuf.parse(protoText).root;
  console.log('✅ GTFS proto loaded');
}

// Load the protobuf schema before handling any requests
await loadProto();

// API endpoint to return decoded bus data as JSON
app.get('/api/buses', async (req, res) => {
  if (!root) return res.status(500).send('Proto not loaded');

  try {
    const response = await fetch(GTFS_FEED_URL);
    const buffer = await response.arrayBuffer();
    const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
    const message = FeedMessage.decode(new Uint8Array(buffer));
    const object = FeedMessage.toObject(message, { defaults: true });
    res.json(object);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to fetch GTFS');
  }
});

app.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
});

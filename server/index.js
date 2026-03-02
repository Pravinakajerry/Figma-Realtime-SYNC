const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- Room & User State ----
const rooms = new Map(); // roomId -> Set<ws>
const userInfo = new Map(); // ws -> { roomId, userName, userPhoto, color }

const USER_COLORS = ['#007AFF', '#34C759', '#FFCC00', '#FF2D55', '#FF9500'];
let colorIndex = 0;

function getNextColor() {
    const color = USER_COLORS[colorIndex % USER_COLORS.length];
    colorIndex++;
    return color;
}

// Broadcast to all clients in a room
function broadcastToRoom(roomId, data, excludeWs) {
    const clients = rooms.get(roomId);
    if (!clients) return;
    const message = JSON.stringify(data);
    for (const client of clients) {
        if (client !== excludeWs && client.readyState === 1) { // WebSocket.OPEN === 1
            client.send(message);
        }
    }
}

// Send the current user list to everyone in a room
function broadcastRoomUsers(roomId) {
    const clients = rooms.get(roomId);
    if (!clients) return;

    const users = [];
    for (const client of clients) {
        const info = userInfo.get(client);
        if (info) {
            users.push({ name: info.userName, photo: info.userPhoto, color: info.color });
        }
    }

    const message = JSON.stringify({ type: 'room_users_update', users });
    for (const client of clients) {
        if (client.readyState === 1) {
            client.send(message);
        }
    }
}

// Remove a client from their room
function removeFromRoom(ws) {
    const info = userInfo.get(ws);
    if (!info) return;

    const roomId = info.roomId;
    const clients = rooms.get(roomId);
    if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
            rooms.delete(roomId);
        } else {
            broadcastRoomUsers(roomId);
        }
    }
    userInfo.delete(ws);
}

wss.on('connection', (ws) => {
    console.log('[Server] New client connected');

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            return;
        }

        if (msg.type === 'join_room') {
            const { roomId, userName, userPhoto } = msg;
            if (!roomId) return;

            // Remove from previous room if any
            removeFromRoom(ws);

            // Add to new room
            if (!rooms.has(roomId)) {
                rooms.set(roomId, new Set());
            }

            const roomClients = rooms.get(roomId);
            const hasExistingUsers = roomClients.size > 0;

            roomClients.add(ws);
            userInfo.set(ws, {
                roomId,
                userName: userName || 'Anonymous',
                userPhoto: userPhoto || null,
                color: getNextColor()
            });

            // Confirm join to the client
            ws.send(JSON.stringify({ type: 'joined', roomId }));

            // Notify existing users that someone new joined (triggers FULL_SYNC from them)
            if (hasExistingUsers) {
                broadcastToRoom(roomId, { type: 'user_joined' }, ws);
            }

            // Broadcast updated user list to everyone in room
            broadcastRoomUsers(roomId);

            console.log(`[Server] "${userName || 'Anonymous'}" joined room: ${roomId} (${roomClients.size} users)`);

        } else if (msg.type === 'sync_event') {
            const info = userInfo.get(ws);
            if (!info) return;

            // Broadcast sync data to everyone else in the room
            broadcastToRoom(info.roomId, { type: 'sync_event', data: msg.data }, ws);

        } else if (msg.type === 'client_log') {
            const info = userInfo.get(ws);
            if (info) {
                console.log(`[Client Log] [${info.userName}@${info.roomId}]`, JSON.stringify(msg.data));
            }

        } else if (msg.type === 'rescan_report') {
            const info = userInfo.get(ws);
            if (info) {
                console.log(`[Rescan Report] [${info.userName}@${info.roomId}] Nodes: ${msg.data?.totalNodes || '?'}`);
            }
        }
    });

    ws.on('close', () => {
        const info = userInfo.get(ws);
        if (info) {
            console.log(`[Server] "${info.userName}" disconnected from room: ${info.roomId}`);
        }
        removeFromRoom(ws);
    });

    ws.on('error', (err) => {
        console.error('[Server] WebSocket error:', err.message);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`WebSocket server listening on port ${PORT}`);
});

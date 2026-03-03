var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
/// <reference types="@figma/plugin-typings" />
// -----------------------------------------
// ID Mapping: RemoteNodeId -> LocalNodeId
// -----------------------------------------
const idMap = new Map();
const imageHashMap = new Map(); // Remote Hash -> Local Hash
const pendingChildren = [];
// Track nodes currently being modified by remote sync to prevent echo loops
const currentlySyncingNodes = new Set();
let isProcessingFullSync = false;
// Show the UI - Minimal Bottom Bar
figma.showUI(__html__, { title: 'Collaboration Sync', width: 260, height: 44, themeColors: true });
const currentUser = figma.currentUser;
if (currentUser) {
    figma.ui.postMessage({
        type: 'init_user',
        name: currentUser.name,
        photoUrl: currentUser.photoUrl
    });
}
const SUPPORTED_NODES = [
    'FRAME', 'RECTANGLE', 'TEXT',
    'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'SECTION', 'GROUP',
    'VECTOR', 'BOOLEAN_OPERATION'
];
const SYNCABLE_PROPS = [
    'name', // Naming
    'x', 'y', 'rotation', 'width', 'height', // Layout
    'opacity', 'blendMode', 'isMask', 'effects', // Blend
    'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'dashPattern', // Geometry
    'cornerRadius', 'cornerSmoothing', // Corner
    'characters', 'fontSize', 'fontName', 'textCase', 'textDecoration', 'letterSpacing', 'lineHeight', 'textAutoResize', 'textAlignHorizontal', 'textAlignVertical', // Text
    'vectorNetwork', 'vectorPaths', // Vectors
    'clipsContent' // Frame/Component specific
];
// -----------------------------------------
// Debounce helper for rapid document changes
// -----------------------------------------
let timeoutId = null;
let pendingChanges = new Map();
function commitPendingChanges() {
    return __awaiter(this, void 0, void 0, function* () {
        const changesToProcess = Array.from(pendingChanges.values());
        pendingChanges.clear();
        timeoutId = null;
        for (const msg of changesToProcess) {
            if (msg.nodeData && msg.nodeData.fills && Array.isArray(msg.nodeData.fills)) {
                const fills = msg.nodeData.fills;
                const imageBytes = {};
                let hasImages = false;
                for (const paint of fills) {
                    if (paint.type === 'IMAGE' && paint.imageHash) {
                        const img = figma.getImageByHash(paint.imageHash);
                        if (img) {
                            try {
                                const bytes = yield img.getBytesAsync();
                                imageBytes[paint.imageHash] = figma.base64Encode(bytes);
                                hasImages = true;
                            }
                            catch (e) {
                                console.error(`[Plugin] Failed to read image bytes for hash ${paint.imageHash}`, e);
                            }
                        }
                    }
                }
                if (hasImages) {
                    msg.nodeData.imageBytes = imageBytes;
                }
            }
            figma.ui.postMessage({ type: 'local_sync', data: msg });
        }
    });
}
function scheduleSync(msg) {
    if (msg.action === 'FULL_SYNC') {
        // Immediate dispatch for full sync
        figma.ui.postMessage({ type: 'local_sync', data: msg });
        return;
    }
    if (!msg.remoteNodeId)
        return;
    const existing = pendingChanges.get(msg.remoteNodeId);
    if (existing) {
        if (existing.action === 'UPSERT' && msg.action === 'DELETE') {
            pendingChanges.delete(msg.remoteNodeId);
        }
        else {
            pendingChanges.set(msg.remoteNodeId, msg);
        }
    }
    else {
        pendingChanges.set(msg.remoteNodeId, msg);
    }
    if (timeoutId === null) {
        timeoutId = setTimeout(commitPendingChanges, 100);
    }
}
// -----------------------------------------
// Helper: Compare properties to prevent echo loops
// -----------------------------------------
function isPayloadDifferent(data1, data2) {
    if (data1 === data2)
        return false;
    if (typeof data1 === 'number' && typeof data2 === 'number') {
        return Math.abs(data1 - data2) > 0.05;
    }
    if (Array.isArray(data1) && Array.isArray(data2)) {
        if (data1.length !== data2.length)
            return true;
        for (let i = 0; i < data1.length; i++) {
            if (isPayloadDifferent(data1[i], data2[i]))
                return true;
        }
        return false;
    }
    if (data1 && typeof data1 === 'object' && data2 && typeof data2 === 'object') {
        for (const key of Object.keys(data1)) {
            if (key === 'imageBytes' || key === 'parentId' || key === 'parentIndex' || key === 'type')
                continue;
            if (data2[key] === undefined && data1[key] !== undefined)
                return true;
            if (isPayloadDifferent(data1[key], data2[key]))
                return true;
        }
        return false;
    }
    return true;
}
// -----------------------------------------
// Helper: Extract Node properties based on Mixins
// -----------------------------------------
function extractNodePayload(node) {
    if (SUPPORTED_NODES.indexOf(node.type) === -1)
        return null;
    const payload = {
        type: node.type
    };
    for (const prop of SYNCABLE_PROPS) {
        if (prop in node) {
            const val = node[prop];
            // figma.mixed cannot be synced directly, we ignore it to prevent crash.
            // Full multi-style support requires `getRange...` which is a future phase.
            if (val !== figma.mixed) {
                payload[prop] = val;
            }
        }
    }
    // Capture Hierarchy
    if (node.parent) {
        if (node.parent.type === 'PAGE') {
            payload.parentId = 'PAGE';
        }
        else {
            // Find remote ID of parent
            let parentRemoteId = node.parent.id;
            for (const [remId, locId] of idMap.entries()) {
                if (locId === node.parent.id) {
                    parentRemoteId = remId;
                    break;
                }
            }
            payload.parentId = parentRemoteId;
        }
        // Find index
        const children = node.parent.children;
        if (children) {
            payload.parentIndex = children.indexOf(node);
        }
    }
    return payload;
}
// -----------------------------------------
// Broadcaster: Listen to Figma changes
// -----------------------------------------
figma.on("documentchange", (event) => {
    // --- FULL_SYNC LOCK: suppress ALL outgoing sync while processing incoming FULL_SYNC ---
    if (isProcessingFullSync)
        return;
    for (const change of event.documentChanges) {
        const node = figma.getNodeById(change.id);
        if (node && SUPPORTED_NODES.indexOf(node.type) === -1) {
            continue;
        }
        // --- INFINITE LOOP PREVENTION ---
        if (node && currentlySyncingNodes.has(node.id)) {
            // Document change caused by our own receiver logic, ignore it.
            continue;
        }
        // Determine the RemoteNodeId to send.
        let remoteIdToSend = null;
        for (const [remId, locId] of idMap.entries()) {
            if (locId === change.id) {
                remoteIdToSend = remId;
                break;
            }
        }
        // If not mapped, map it to itself (handles native local objects and newly authored content)
        if (!remoteIdToSend) {
            remoteIdToSend = change.id;
            idMap.set(change.id, change.id);
        }
        if (change.type === 'CREATE' || change.type === 'PROPERTY_CHANGE') {
            if (!node)
                continue;
            const payload = extractNodePayload(node);
            if (payload) {
                payload.id = remoteIdToSend; // Ensure payload carries its master ID
                // console.log(`[Plugin] Emitting UPSERT: ${remoteIdToSend}`);
                scheduleSync({ action: 'UPSERT', remoteNodeId: remoteIdToSend, nodeData: payload });
            }
            // Explicitly broadcast children property changes if a parent moves/resizes natively 
            if (change.type === 'PROPERTY_CHANGE' && 'children' in node && (change.properties.indexOf('x') !== -1 || change.properties.indexOf('y') !== -1)) {
                const sweepChildren = (parent) => {
                    for (const child of parent.children) {
                        const childPayload = extractNodePayload(child);
                        if (childPayload) {
                            let childRemoteId = child.id;
                            for (const [remId, locId] of idMap.entries()) {
                                if (locId === child.id) {
                                    childRemoteId = remId;
                                    break;
                                }
                            }
                            if (!idMap.has(childRemoteId))
                                idMap.set(childRemoteId, childRemoteId);
                            childPayload.id = childRemoteId;
                            scheduleSync({ action: 'UPSERT', remoteNodeId: childRemoteId, nodeData: childPayload });
                        }
                        if ('children' in child)
                            sweepChildren(child);
                    }
                };
                sweepChildren(node);
            }
        }
        else if (change.type === 'DELETE') {
            console.log(`[Plugin] Emitting DELETE: ${remoteIdToSend}`);
            scheduleSync({ action: 'DELETE', remoteNodeId: remoteIdToSend });
        }
    }
});
// -----------------------------------------
// Receiver: Apply changes from Server
// -----------------------------------------
function processUpsertPass1(nodeData) {
    return __awaiter(this, void 0, void 0, function* () {
        const remoteNodeId = nodeData.id;
        if (!remoteNodeId)
            return null;
        let localId = idMap.get(remoteNodeId);
        let node = null;
        if (localId) {
            node = figma.getNodeById(localId);
        }
        // CREATE if doesn't exist
        if (!node) {
            switch (nodeData.type) {
                case 'RECTANGLE':
                    node = figma.createRectangle();
                    break;
                case 'FRAME':
                    node = figma.createFrame();
                    break;
                case 'TEXT':
                    node = figma.createText();
                    break;
                case 'ELLIPSE':
                    node = figma.createEllipse();
                    break;
                case 'POLYGON':
                    node = figma.createPolygon();
                    break;
                case 'STAR':
                    node = figma.createStar();
                    break;
                case 'LINE':
                    node = figma.createLine();
                    break;
                case 'SECTION':
                    node = figma.createSection();
                    break;
                case 'VECTOR':
                    node = figma.createVector();
                    break;
                case 'BOOLEAN_OPERATION':
                    node = figma.createVector();
                    break;
                case 'GROUP':
                    const dummy = figma.createRectangle();
                    dummy.name = "Sync Dummy";
                    node = figma.group([dummy], figma.currentPage);
                    break;
            }
            if (node) {
                idMap.set(remoteNodeId, node.id);
                // Append temporarily to root if new, pass 2 will fix hierarchy
                if (!node.parent) {
                    figma.currentPage.appendChild(node);
                }
            }
        }
        if (!node)
            return null;
        // --- ECHO LOOP PREVENTION FOR UPSERTS ---
        const currentPayload = extractNodePayload(node);
        let hasDifference = true;
        if (currentPayload) {
            hasDifference = isPayloadDifferent(nodeData, currentPayload);
            // We do NOT diff parentId/parentIndex here, because hierarchy check happens in pass 2
        }
        if (!hasDifference)
            return node;
        // UPDATE Properties
        currentlySyncingNodes.add(node.id);
        yield applyProperties(node, nodeData);
        setTimeout(() => currentlySyncingNodes.delete(node.id), 200);
        return node;
    });
}
function processUpsertPass2(nodeData) {
    const remoteNodeId = nodeData.id;
    if (!remoteNodeId)
        return;
    const localId = idMap.get(remoteNodeId);
    if (!localId)
        return;
    const node = figma.getNodeById(localId);
    if (!node)
        return;
    currentlySyncingNodes.add(localId);
    placeNodeInHierarchy(node, nodeData.parentId, nodeData.parentIndex);
    setTimeout(() => currentlySyncingNodes.delete(localId), 200);
}
figma.ui.onmessage = (msg) => __awaiter(this, void 0, void 0, function* () {
    if (msg.type === 'trigger_rescan') {
        try {
            const allNodes = [];
            const sweep = (parent) => {
                for (const child of parent.children) {
                    const payload = extractNodePayload(child);
                    if (payload) {
                        let remoteIdToSend = child.id;
                        for (const [remId, locId] of idMap.entries()) {
                            if (locId === child.id) {
                                remoteIdToSend = remId;
                                break;
                            }
                        }
                        if (!idMap.has(remoteIdToSend))
                            idMap.set(remoteIdToSend, child.id);
                        payload.id = remoteIdToSend;
                        allNodes.push(payload);
                    }
                    if ('children' in child)
                        sweep(child);
                }
            };
            figma.ui.postMessage({ type: 'local_log', data: { event: 'RESCAN_STARTING', pageId: figma.currentPage.id } });
            sweep(figma.currentPage);
            figma.ui.postMessage({ type: 'local_log', data: { event: 'RESCAN_SWEEP_DONE', totalNodes: allNodes.length } });
            figma.ui.postMessage({ type: 'rescan_report', data: { timestamp: Date.now(), totalNodes: allNodes.length, nodes: allNodes } });
        }
        catch (e) {
            figma.ui.postMessage({ type: 'local_log', data: { event: 'RESCAN_ERROR', error: e.message } });
        }
        return;
    }
    if (msg.type === 'user_joined') {
        console.log("[Plugin] A new user joined! Sending FULL_SYNC.");
        const allNodes = [];
        const sweep = (parent) => {
            for (const child of parent.children) {
                const payload = extractNodePayload(child);
                if (payload) {
                    let remoteIdToSend = child.id;
                    for (const [remId, locId] of idMap.entries()) {
                        if (locId === child.id) {
                            remoteIdToSend = remId;
                            break;
                        }
                    }
                    if (!idMap.has(remoteIdToSend))
                        idMap.set(remoteIdToSend, child.id);
                    payload.id = remoteIdToSend;
                    allNodes.push(payload);
                }
                if ('children' in child)
                    sweep(child);
            }
        };
        sweep(figma.currentPage);
        scheduleSync({ action: 'FULL_SYNC', nodes: allNodes });
        return;
    }
    if (msg.type === 'remote_sync') {
        const data = msg.data;
        console.log("[Plugin] Received remote_sync:", data);
        if (!data.action)
            return;
        if (data.action === 'FULL_SYNC' && data.nodes) {
            console.log(`[Plugin] Received FULL_SYNC with ${data.nodes.length} nodes.`);
            // LOCK: suppress all outgoing documentChange events during processing
            isProcessingFullSync = true;
            figma.ui.postMessage({ type: 'sync_status', syncing: true });
            // Instead of blocking, do an exact-match diff to map existing local nodes
            // to remote nodes without duplicating them.
            const localNodesCount = figma.currentPage.children.filter(n => SUPPORTED_NODES.indexOf(n.type) !== -1).length;
            if (localNodesCount > 0 && data.nodes.length > 0) {
                console.log("[Plugin] Local canvas has elements. Performing exact-match diffing...");
                // Keep track of which local nodes we've already matched to avoid double-mapping
                const matchedLocalIds = new Set();
                for (const remoteNodeData of data.nodes) {
                    if (idMap.has(remoteNodeData.id))
                        continue; // Already mapped
                    // Search for a local node that is exactly the same and not already mapped
                    const sweepDiff = (parent) => {
                        for (const localChild of parent.children) {
                            if (SUPPORTED_NODES.indexOf(localChild.type) === -1)
                                continue;
                            if (matchedLocalIds.has(localChild.id))
                                continue;
                            // Check if this local node is already mapped to someone else
                            let isMapped = false;
                            for (const [remId, locId] of idMap.entries()) {
                                if (locId === localChild.id) {
                                    isMapped = true;
                                    break;
                                }
                            }
                            if (isMapped)
                                continue;
                            // Extract payload of local node to compare
                            const localPayload = extractNodePayload(localChild);
                            if (localPayload && localPayload.type === remoteNodeData.type) {
                                const isDiff = isPayloadDifferent(remoteNodeData, localPayload);
                                if (!isDiff) {
                                    // Exact Match! Map them.
                                    idMap.set(remoteNodeData.id, localChild.id);
                                    matchedLocalIds.add(localChild.id);
                                    return true;
                                }
                            }
                            if ('children' in localChild) {
                                if (sweepDiff(localChild))
                                    return true;
                            }
                        }
                        return false;
                    };
                    sweepDiff(figma.currentPage);
                }
            }
            // PASS 1: Instantiation & Properties
            for (const nodeData of data.nodes) {
                yield processUpsertPass1(nodeData);
            }
            // PASS 2: Hierarchy
            for (const nodeData of data.nodes) {
                processUpsertPass2(nodeData);
            }
            // UNLOCK: allow documentChange events to flow again after a settle delay
            setTimeout(() => {
                isProcessingFullSync = false;
                figma.ui.postMessage({ type: 'sync_status', syncing: false });
                // MERGE: Find locally authored nodes that the host doesn't know about and broadcast them
                const remoteIdsInSync = new Set(data.nodes.map((n) => n.id));
                const sweepMerge = (parent) => {
                    for (const child of parent.children) {
                        if (SUPPORTED_NODES.indexOf(child.type) === -1)
                            continue;
                        let remoteIdToSend = child.id;
                        for (const [remId, locId] of idMap.entries()) {
                            if (locId === child.id) {
                                remoteIdToSend = remId;
                                break;
                            }
                        }
                        if (!remoteIdsInSync.has(remoteIdToSend)) {
                            const payload = extractNodePayload(child);
                            if (payload) {
                                if (!idMap.has(remoteIdToSend))
                                    idMap.set(remoteIdToSend, child.id);
                                payload.id = remoteIdToSend;
                                scheduleSync({ action: 'UPSERT', remoteNodeId: remoteIdToSend, nodeData: payload });
                            }
                        }
                        if ('children' in child)
                            sweepMerge(child);
                    }
                };
                sweepMerge(figma.currentPage);
            }, 500);
        }
        else if (data.action === 'UPSERT' && data.nodeData) {
            data.nodeData.id = data.remoteNodeId;
            if (data.remoteNodeId)
                pendingChanges.delete(data.remoteNodeId); // Clear outbound echo
            yield processUpsertPass1(data.nodeData);
            processUpsertPass2(data.nodeData);
        }
        else if (data.action === 'DELETE' && data.remoteNodeId) {
            pendingChanges.delete(data.remoteNodeId); // Clear outbound echo
            let localId = idMap.get(data.remoteNodeId);
            if (!localId && figma.getNodeById(data.remoteNodeId)) {
                localId = data.remoteNodeId;
            }
            if (!localId) {
                console.log(`[Plugin] Ignoring DELETE: Cannot find mapping for remote ${data.remoteNodeId}`);
                return;
            }
            const node = figma.getNodeById(localId);
            if (node) {
                console.log(`[Plugin] Deleting local node ${localId}`);
                currentlySyncingNodes.add(localId);
                node.remove();
                setTimeout(() => currentlySyncingNodes.delete(localId), 200);
            }
            idMap.delete(data.remoteNodeId);
        }
    }
    else if (msg.type === 'resize') {
        figma.ui.resize(msg.width, msg.height);
    }
    else if (msg.type === 'open_url' && msg.url) {
        figma.openExternal(msg.url);
    }
});
// -----------------------------------------
// Helper: Place node in correct parent and index
// -----------------------------------------
function checkPendingChildren(newRemoteParentId, newLocalParentId) {
    const parentNode = figma.getNodeById(newLocalParentId);
    if (!parentNode || !('children' in parentNode) || typeof parentNode.insertChild !== 'function')
        return;
    const parentWithChildren = parentNode;
    for (let i = pendingChildren.length - 1; i >= 0; i--) {
        const pending = pendingChildren[i];
        if (pending.expectedParentId === newRemoteParentId) {
            const childNode = figma.getNodeById(pending.nodeId);
            if (childNode) {
                let safeIndex = pending.expectedIndex;
                if (safeIndex < 0 || safeIndex > parentWithChildren.children.length) {
                    safeIndex = parentWithChildren.children.length;
                }
                currentlySyncingNodes.add(childNode.id);
                parentWithChildren.insertChild(safeIndex, childNode);
                setTimeout(() => currentlySyncingNodes.delete(childNode.id), 200);
            }
            pendingChildren.splice(i, 1);
        }
    }
}
function placeNodeInHierarchy(node, parentId, parentIndex) {
    if (!parentId) {
        if (!node.parent)
            figma.currentPage.appendChild(node);
        return;
    }
    let parentNode = null;
    if (parentId === 'PAGE') {
        parentNode = figma.currentPage;
    }
    else {
        const localParentId = idMap.get(parentId);
        if (localParentId) {
            parentNode = figma.getNodeById(localParentId);
        }
        else {
            // Parent hasn't arrived yet! Queue it and temporarily place on page.
            pendingChildren.push({
                nodeId: node.id,
                expectedParentId: parentId,
                expectedIndex: parentIndex !== undefined ? parentIndex : -1
            });
            if (!node.parent) {
                figma.currentPage.appendChild(node);
            }
            return;
        }
    }
    if (parentNode && 'children' in parentNode && typeof parentNode.insertChild === 'function') {
        const parentWithChildren = parentNode;
        let safeIndex = parentIndex !== undefined ? parentIndex : parentWithChildren.children.length;
        // Adjust index if node is already a child of this parent
        if (node.parent === parentNode) {
            const currentIndex = parentWithChildren.children.indexOf(node);
            if (safeIndex > currentIndex) {
                safeIndex--; // Shift index due to removal
            }
        }
        if (safeIndex < 0)
            safeIndex = 0;
        if (safeIndex > parentWithChildren.children.length)
            safeIndex = parentWithChildren.children.length;
        parentWithChildren.insertChild(safeIndex, node);
        // Group specific cleanup: groups must have at least 1 child. If we just added a real child, 
        // and the dummy is still there, we can now safely remove the dummy.
        if (parentWithChildren.type === 'GROUP' && parentWithChildren.children.length > 1) {
            const dummy = parentWithChildren.children.find(c => c.name === "Sync Dummy");
            if (dummy)
                dummy.remove();
        }
    }
    else {
        console.warn(`[Plugin] Could not find valid parent for ${node.id}, defaulting to page.`);
        if (!node.parent) {
            figma.currentPage.appendChild(node);
        }
    }
}
// -----------------------------------------
// Helper: Apply Node properties based on Mixins
// -----------------------------------------
function applyProperties(node, data) {
    return __awaiter(this, void 0, void 0, function* () {
        // 1. Handle Layout First
        if ('x' in data)
            node.x = data.x;
        if ('y' in data)
            node.y = data.y;
        if ('rotation' in data && 'rotation' in node)
            node.rotation = data.rotation;
        // Resize requires strictly positive numbers
        if ('width' in data && 'height' in data && 'resize' in node) {
            if (data.width > 0 && data.height > 0) {
                // LineNode height is 0, so resizing fails. Handle lines gracefully.
                if (node.type === 'LINE') {
                    try {
                        node.resize(data.width, 0);
                    }
                    catch (e) { }
                }
                else {
                    node.resize(data.width, data.height);
                }
            }
        }
        // 2. Handle Text Specifics (requires awaiting font load)
        if (node.type === 'TEXT' && data.type === 'TEXT') {
            const textNode = node;
            let fontNameObj = data.fontName || { family: "Inter", style: "Regular" };
            // Load fonts
            if (textNode.hasMissingFont) {
                yield figma.loadFontAsync({ family: "Inter", style: "Regular" });
            }
            else {
                yield figma.loadFontAsync(textNode.fontName);
            }
            yield figma.loadFontAsync(fontNameObj);
            // Apply text props safely
            const textProps = ['characters', 'fontSize', 'fontName', 'textCase', 'textDecoration', 'letterSpacing', 'lineHeight', 'textAutoResize', 'textAlignHorizontal', 'textAlignVertical'];
            for (const prop of textProps) {
                if (prop in data && prop in textNode) {
                    try {
                        textNode[prop] = data[prop];
                    }
                    catch (e) {
                        console.warn(`Failed to set text prop ${prop}`, e);
                    }
                }
            }
        }
        // 3. Handle Images in Fills array
        if (data.imageBytes && data.fills && Array.isArray(data.fills)) {
            for (const remoteHash of Object.keys(data.imageBytes)) {
                const base64 = data.imageBytes[remoteHash];
                if (!imageHashMap.has(remoteHash)) {
                    try {
                        const bytes = figma.base64Decode(base64);
                        const localImage = figma.createImage(bytes);
                        imageHashMap.set(remoteHash, localImage.hash);
                    }
                    catch (e) {
                        console.error(`[Plugin] Failed to decode image bytes for remote hash ${remoteHash}`, e);
                    }
                }
            }
            const newFills = [];
            for (const paint of data.fills) {
                if (paint.type === 'IMAGE' && paint.imageHash && imageHashMap.has(paint.imageHash)) {
                    newFills.push(Object.assign(Object.assign({}, paint), { imageHash: imageHashMap.get(paint.imageHash) }));
                }
                else {
                    newFills.push(paint);
                }
            }
            data.fills = newFills;
        }
        // 3.5 Handle Vector Network specifically (Async)
        if (data.vectorNetwork && 'setVectorNetworkAsync' in node) {
            try {
                yield node.setVectorNetworkAsync(data.vectorNetwork);
            }
            catch (e) {
                console.error(`[Plugin] Failed to set VectorNetwork`, e);
            }
        }
        else if (data.vectorPaths && 'vectorPaths' in node) {
            try {
                node.vectorPaths = data.vectorPaths;
            }
            catch (e) { }
        }
        // 4. Handle Generic Mixin Properties (Fills, Strokes, Effects, etc.)
        const excludeProps = ['x', 'y', 'rotation', 'width', 'height', 'characters', 'fontSize', 'fontName', 'textCase', 'textDecoration', 'letterSpacing', 'lineHeight', 'textAutoResize', 'textAlignHorizontal', 'textAlignVertical', 'type', 'id', 'imageBytes', 'vectorNetwork', 'vectorPaths'];
        for (const prop of SYNCABLE_PROPS) {
            if (excludeProps.indexOf(prop) !== -1)
                continue;
            if (prop in data && prop in node) {
                try {
                    // Ensure we do a deep clone if needed, but Figma API usually accepts raw mapped arrays.
                    node[prop] = data[prop];
                }
                catch (e) {
                    console.warn(`Failed to set generic prop ${prop}`, e);
                }
            }
        }
    });
}

const express = require('express');
const { MongoClient } = require('mongodb');
const Queue = require('bull');
const app = express();
app.use(express.json());

// MongoDB and Redis connections
const mongoUri = 'mongodb://localhost:27017';
const client = new MongoClient(mongoUri);
const db = client.db('lg_network');
const taskQueue = new Queue('lg-network-tasks', 'redis://127.0.0.1:6379');

// Simple LG implementation
function simpleLG(stInputs, ptInputs, b) {
    const I1 = stInputs.reduce((sum, x) => sum + x, 0);
    const I2 = ptInputs.reduce((prod, x) => prod * x, 1);
    const Q1 = Math.floor(I1 / b);
    let R1 = I1 % b;
    if (R1 === 0) R1 = 1; // R1 + 1 rule
    const Q2 = Math.floor(I2 / R1);
    const R2 = I2 % R1;
    const Q = Q1 + R2;
    const O = Q + Q2;
    return { O, Q, Q2 };
}

// Associated LG (two chained LGs)
function associatedLG(stInputs, ptInputs, b1, b2) {
    const lg1Result = simpleLG(stInputs, ptInputs, b1);
    const lg2Result = simpleLG([lg1Result.Q2], [lg1Result.Q], b2);
    return { O: lg2Result.O, Q: lg2Result.Q, Q2: lg2Result.Q2 };
}

// Looped LG (feedback iterations)
function loopedLG(stInputs, ptInputs, b, iterations = 5) {
    let I1 = stInputs.reduce((sum, x) => sum + x, 0);
    let I2 = ptInputs.reduce((prod, x) => prod * x, 1);
    let lastResult;
    for (let i = 0; i < iterations; i++) {
        lastResult = simpleLG([I1], [I2], b);
        I1 = lastResult.Q2; // Feedback
        I2 = lastResult.Q;
    }
    return lastResult;
}

// Compute network
function computeNetwork(inputs, connections, biases) {
    let lgOutputs = [];
    for (const conn of connections) {
        if (conn.type === 'simple') {
            lgOutputs.push(simpleLG(conn.stInputs, conn.ptInputs, biases[conn.lgId]));
        } else if (conn.type === 'associated') {
            lgOutputs.push(associatedLG(conn.stInputs, conn.ptInputs, biases[conn.lgId].b1, biases[conn.lgId].b2));
        } else if (conn.type === 'looped') {
            lgOutputs.push(loopedLG(conn.stInputs, conn.ptInputs, biases[conn.lgId], conn.iterations || 5));
        }
    }
    // Output block: Sum LG outputs
    return lgOutputs.reduce((sum, res) => sum + res.O, 0);
}

// Backpropagation (basic example, customize based on your rules)
async function backpropagate(taskId, connections, lgConfig) {
    const results = await db.collection('results').find({}).sort({ timestamp: -1 }).limit(10).toArray();
    const outputs = results.map(r => r.O_final);
    const stats = {
        mean: outputs.reduce((sum, x) => sum + x, 0) / outputs.length,
        median: outputs.sort((a, b) => a - b)[Math.floor(outputs.length / 2)],
        mode: outputs.reduce((acc, val) => {
            acc[val] = (acc[val] || 0) + 1;
            return acc[val] > acc[acc.mode] ? { mode: val } : acc;
        }, { mode: outputs[0] }).mode
    };
    // Example: Adjust connections/LGs based on stats
    if (stats.mean > 100) {
        connections.push({ type: 'looped', lgId: `lg${Date.now()}`, stInputs: [], ptInputs: [], iterations: 5 });
        lgConfig.push({ type: 'looped', bias: 3 });
    }
    return { connections, lgConfig };
}

// Task queue processing
taskQueue.process(async (job) => {
    const { inputs, connections, biases, lgConfig } = job.data;
    const O_final = computeNetwork(inputs, connections, biases);
    const updatedConfig = await backpropagate(job.id, connections, lgConfig);
    await db.collection('results').insertOne({
        taskId: job.id,
        O_final,
        inputs,
        connections: updatedConfig.connections,
        lgConfig: updatedConfig.lgConfig,
        timestamp: new Date()
    });
    return O_final;
});

// REST API: Submit task
app.post('/submit_task', async (req, res) => {
    const { inputs, connections = [], biases = {}, lgConfig = [] } = req.body;
    const job = await taskQueue.add({ inputs, connections, biases, lgConfig });
    res.json({ taskId: job.id });
});

// REST API: Get results
app.get('/results/:taskId', async (req, res) => {
    const result = await db.collection('results').findOne({ taskId: req.params.taskId });
    res.json(result || { error: 'Result not found' });
});

// Serve static files (GUI)
app.use(express.static('public'));

// Start server
app.listen(8000, () => console.log('Server running on port 8000'));

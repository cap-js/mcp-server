import { json, text } from 'node:stream/consumers'

import cds from '@sap/cds'
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"

import { createServer } from './index.js'

const transports = {}
transports.create = async function () {
  // New initialization request
  const transport = new StreamableHTTPServerTransport({
    // REVISIT: potentially use cds.context middleware
    sessionIdGenerator: () => { return cds.utils.uuid() },
    onsessioninitialized: (sessionId) => {
      console.log('started session:', sessionId)
      transports[sessionId] = transport
    },
    // enableDnsRebindingProtection: true,
    // allowedHosts: ['127.0.0.1'],
  })

  // Clean up transport when closed
  transport.onclose = () => {
    if (transport.sessionId) {
      delete transports[transport.sessionId]
    }
  }

  await createServer().connect(transport)

  return transport
}

cds.on('bootstrap', async app => {

  app.post('/mcp', async (req, res) => {
    const body = await text(req)
    if (body) req.body = JSON.parse(body)

    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id']
    let transport

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      console.log('handling session:', sessionId)
      transport = transports[sessionId]
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = await transports.create(req, res)
    } else {
      // Invalid request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      })
      return
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body)
  })

  // Reusable handler for GET and DELETE requests
  const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers['mcp-session-id']
    if (!sessionId || !transports[sessionId]) {
      return res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed."
        },
        id: null
      }))
    }
    const transport = transports[sessionId]
    await transport.handleRequest(req, res)
  }

  // Handle GET requests for server-to-client notifications via SSE
  app.get('/mcp', handleSessionRequest)

  // Handle DELETE requests for session termination
  app.delete('/mcp', handleSessionRequest)

  app.get("/mcp/sse", async (req, res) => {
    let transport
    const server = await createServer()

    if (req?.query?.sessionId) {
      const sessionId = (req?.query?.sessionId)
      transport = transports[sessionId]
      console.log("Client Reconnecting? This shouldn't happen when client has a sessionId, GET /sse should not be called again.", transport.sessionId)
    } else {
      // Create and store transport for new session
      transport = new SSEServerTransport("/message", res)
      transports[transport.sessionId] = transport

      // Connect server to transport
      await server.connect(transport)
      console.log("Client Connected: ", transport.sessionId)

      // Handle close of connection
      server.onclose = async () => {
        console.log("Client Disconnected: ", transport.sessionId)
        delete transports[transport.sessionId]
        await cleanup()
      }
    }
  })

  app.post("/message", async (req, res) => {
    const sessionId = (req?.query?.sessionId)
    const transport = transports[sessionId]
    if (transport) {
      console.log("Client Message from", sessionId)
      await transport.handlePostMessage(req, res)
    } else {
      console.log(`No transport found for sessionId ${sessionId}`)
    }
  })
})

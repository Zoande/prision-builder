import { defineConfig } from "vite";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const savePath = resolve(process.cwd(), "prototype-save.json");
const simLogPath = resolve(process.cwd(), "sim-log.jsonl");

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (path.includes("/src/render/") || path.endsWith(".wgsl")) return "rendering";
          if (path.includes("/src/sim/")) return "simulation";
          return undefined;
        },
      },
    },
  },
  plugins: [{
    name: "prototype-save-file",
    configureServer(server) {
      server.middlewares.use("/api/save", async (req, res) => {
        try {
          if (req.method === "GET") {
            res.setHeader("Content-Type", "application/json");
            res.end(existsSync(savePath) ? readFileSync(savePath, "utf8") : "null");
            return;
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            const incoming = JSON.parse(body);
            if (incoming?.version !== 6) throw new Error("Only save version 6 is accepted");
            writeFileSync(savePath, body, "utf8");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === "DELETE") {
            writeFileSync(savePath, "null", "utf8");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end("Method Not Allowed");
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err instanceof Error ? err.message : err));
        }
      });
      server.middlewares.use("/api/sim-log", async (req, res) => {
        try {
          if (req.method === "DELETE") {
            writeFileSync(simLogPath, "", "utf8");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === "GET") {
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(existsSync(simLogPath) ? readFileSync(simLogPath, "utf8") : "");
            return;
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            JSON.parse(body);
            appendFileSync(simLogPath, `${body}\n`, "utf8");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end("Method Not Allowed");
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err instanceof Error ? err.message : err));
        }
      });
    },
  }],
});

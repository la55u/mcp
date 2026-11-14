// An MCP Apps view (SEP-1865) for `list_todos`. Hosts that support MCP Apps
// fetch it with `resources/read` and render it in a sandboxed iframe; other
// hosts ignore `_meta.ui` and show the tool's text content.
// No SDK: the host talks JSON-RPC over postMessage.

export const TODOS_VIEW_URI = "ui://todos/list";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const todosViewHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      :root {
        color-scheme: light dark;
        font-family: var(--font-sans, system-ui, sans-serif);
        color: var(--color-text-primary, CanvasText);
      }
      body { margin: 0; padding: 12px; }
      ul { list-style: none; margin: 0; padding: 0; }
      li { padding: 4px 0; }
      li.done { opacity: 0.6; text-decoration: line-through; }
      p { margin: 0; color: var(--color-text-secondary, GrayText); }
    </style>
  </head>
  <body>
    <p id="status">Loading…</p>
    <ul id="todos"></ul>
    <script>
      let nextId = 1;
      const pending = new Map();
      const send = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
      const request = (method, params) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          send({ id, method, params });
        });

      function render(result) {
        const todos = result?.structuredContent?.todos;
        const status = document.getElementById("status");
        const list = document.getElementById("todos");
        list.replaceChildren();
        if (!Array.isArray(todos)) {
          status.textContent = "No todos to show.";
          return;
        }
        status.textContent = todos.length === 1 ? "1 todo" : todos.length + " todos";
        for (const todo of todos) {
          const item = document.createElement("li");
          item.textContent = (todo.done ? "☑ " : "☐ ") + todo.text;
          if (todo.done) item.className = "done";
          list.append(item);
        }
      }

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.id !== undefined && pending.has(message.id)) {
          const { resolve, reject } = pending.get(message.id);
          pending.delete(message.id);
          message.error ? reject(message.error) : resolve(message.result);
        } else if (message.method === "ui/notifications/tool-result") {
          render(message.params);
        } else if (message.method === "ui/resource-teardown" && message.id !== undefined) {
          send({ id: message.id, result: {} });
        }
      });

      new ResizeObserver(() => {
        const { width, height } = document.documentElement.getBoundingClientRect();
        send({ method: "ui/notifications/size-changed", params: { width, height } });
      }).observe(document.documentElement);

      request("ui/initialize", {
        protocolVersion: "2026-01-26",
        appInfo: { name: "todos-view", version: "0.1.0" },
        appCapabilities: { availableDisplayModes: ["inline"] },
      }).then(() => send({ method: "ui/notifications/initialized" }));
    </script>
  </body>
</html>
`;

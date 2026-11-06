import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2";

const $ = (s) => document.querySelector(s);
const STORAGE_KEY = "pocket-agent-files-v1";
const DEFAULT_FILES = {
  "index.html": `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My project</title><link rel="stylesheet" href="styles.css"></head>
<body><main><h1>Hello, world.</h1><p>Your project preview appears here.</p><button id="hello">Test button</button></main><script src="script.js"></script></body>
</html>`,
  "styles.css": `body{font-family:system-ui,sans-serif;margin:0;padding:3rem;background:#f4f5fb;color:#202436}main{max-width:720px;margin:10vh auto;background:white;padding:2rem;border-radius:18px;box-shadow:0 12px 40px #18204412}button{padding:.7rem 1rem;border:0;border-radius:8px;background:#6b5ce7;color:white}`,
  "script.js": `document.querySelector("#hello")?.addEventListener("click",()=>alert("It works!"));`,
  "README.md": `# My Pocket Agent project\n\nEdit the files in Pocket Agent and use Preview to view index.html.`
};

let projectFiles = loadFiles();
let activeFile = "index.html";
let model = null;
let pyodideWorker = null;
let pendingPython = new Map();
let pythonRequestId = 0;
let busy = false;

function loadFiles() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || structuredClone(DEFAULT_FILES); }
  catch { return structuredClone(DEFAULT_FILES); }
}
function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projectFiles));
  $("#save-status").textContent = "Saved locally · " + new Date().toLocaleTimeString();
}
function setStatus(text) { $("#runtime-status").textContent = text; }
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

function renderFiles() {
  const list = $("#file-list");
  list.innerHTML = "";
  Object.keys(projectFiles).sort().forEach(name => {
    const b = document.createElement("button");
    b.className = "file-item" + (name === activeFile ? " active" : "");
    b.textContent = "▤  " + name;
    b.addEventListener("click", () => selectFile(name));
    list.appendChild(b);
  });
}
function selectFile(name) {
  if (!(name in projectFiles)) return;
  activeFile = name;
  $("#active-file-name").textContent = name;
  $("#code-editor").value = projectFiles[name];
  renderFiles();
  switchPanel("editor");
}
function saveActiveFile() {
  projectFiles[activeFile] = $("#code-editor").value;
  persist(); renderFiles();
}
function switchPanel(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.panel === name));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === `panel-${name}`));
  if (name === "preview") refreshPreview();
}
function log(message, kind="info") {
  const out = $("#console-output");
  const prefix = kind === "error" ? "[error] " : kind === "python" ? "[python] " : "[output] ";
  out.textContent += (out.textContent ? "\n" : "") + prefix + String(message);
  out.scrollTop = out.scrollHeight;
}
function clearLog() { $("#console-output").textContent = ""; }

function refreshPreview() {
  saveActiveFile();
  const html = projectFiles["index.html"] || "<h1>Create an index.html file to preview your project.</h1>";
  const css = projectFiles["styles.css"] || "";
  const js = projectFiles["script.js"] || "";
  let doc = html;
  if (/<\/head>/i.test(doc)) doc = doc.replace(/<\/head>/i, `<style>${css.replace(/<\/style/gi,"<\\/style")}</style></head>`);
  else doc = `<style>${css}</style>` + doc;
  if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `<script>${js.replace(/<\/script/gi,"<\\/script")}</script></body>`);
  else doc += `<script>${js.replace(/<\/script/gi,"<\\/script")}</script>`;
  $("#preview-frame").srcdoc = doc;
}

function makeJSSandbox() {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.display = "none";
  frame.srcdoc = `<!doctype html><script>
    addEventListener("message", async (event) => {
      if (event.data?.type !== "POCKET_RUN_JS") return;
      const id = event.data.id; const output = [];
      const safeConsole = {
        log:(...a)=>output.push(a.map(String).join(" ")),
        info:(...a)=>output.push(a.map(String).join(" ")),
        warn:(...a)=>output.push("[warn] "+a.map(String).join(" ")),
        error:(...a)=>output.push("[error] "+a.map(String).join(" "))
      };
      try {
        const fn = new Function("console", '"use strict"; return (async()=>{'+event.data.code+'})()');
        const result = await fn(safeConsole);
        if (result !== undefined) output.push(String(result));
        parent.postMessage({type:"POCKET_JS_RESULT",id,ok:true,output}, "*");
      } catch(e) {
        parent.postMessage({type:"POCKET_JS_RESULT",id,ok:false,error:String(e?.stack||e)}, "*");
      }
    });
  <\/script>`;
  document.body.appendChild(frame);
  return frame;
}
const jsFrame = makeJSSandbox();
const jsPending = new Map();
let jsRequestId = 0;
window.addEventListener("message", e => {
  if (e.data?.type !== "POCKET_JS_RESULT") return;
  const resolve = jsPending.get(e.data.id);
  if (resolve) { jsPending.delete(e.data.id); resolve(e.data); }
});
function runJS(code) {
  return new Promise(resolve => {
    const id = ++jsRequestId;
    const timer = setTimeout(() => { jsPending.delete(id); resolve({ok:false,error:"Execution timed out after 8 seconds."}); }, 8000);
    jsPending.set(id, result => { clearTimeout(timer); resolve(result); });
    jsFrame.contentWindow.postMessage({type:"POCKET_RUN_JS",id,code}, "*");
  });
}

function ensurePythonWorker() {
  if (pyodideWorker) return;
  const workerCode = `
    let pyodide;
    self.onmessage = async (event) => {
      const {id, code} = event.data;
      try {
        if (!pyodide) {
          importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js");
          pyodide = await loadPyodide();
        }
        let captured = "";
        pyodide.setStdout({batched:(s)=>{captured += s + "\\\\n";}});
        pyodide.setStderr({batched:(s)=>{captured += "[stderr] " + s + "\\\\n";}});
        const result = await pyodide.runPythonAsync(code);
        self.postMessage({id,ok:true,output:captured + (result === undefined ? "" : String(result))});
      } catch(e) { self.postMessage({id,ok:false,error:String(e?.stack||e)}); }
    };`;
  const blob = new Blob([workerCode], {type:"text/javascript"});
  pyodideWorker = new Worker(URL.createObjectURL(blob));
  pyodideWorker.onmessage = e => {
    const resolve = pendingPython.get(e.data.id);
    if (resolve) { pendingPython.delete(e.data.id); resolve(e.data); }
  };
  pyodideWorker.onerror = e => log("Python worker: " + e.message, "error");
}
function runPython(code) {
  ensurePythonWorker();
  return new Promise(resolve => {
    const id = ++pythonRequestId;
    pendingPython.set(id, resolve);
    pyodideWorker.postMessage({id,code});
  });
}

async function executeTool(name, args={}) {
  if (name === "list_files") return Object.keys(projectFiles);
  if (name === "read_file") {
    if (!(args.path in projectFiles)) throw new Error("File not found: " + args.path);
    return projectFiles[args.path];
  }
  if (name === "write_file") {
    if (!args.path || typeof args.content !== "string") throw new Error("write_file needs path and string content.");
    if (args.path.includes("..") || args.path.startsWith("/")) throw new Error("Use a simple project-relative file path.");
    projectFiles[args.path] = args.content; persist(); renderFiles();
    if (args.path === activeFile) $("#code-editor").value = args.content;
    return `Saved ${args.path} (${args.content.length} characters).`;
  }
  if (name === "run_javascript") {
    const result = await runJS(String(args.code || ""));
    if (!result.ok) throw new Error(result.error);
    return result.output.join("\n") || "JavaScript finished with no output.";
  }
  if (name === "run_python") {
    const result = await runPython(String(args.code || ""));
    if (!result.ok) throw new Error(result.error);
    return result.output || "Python finished with no output.";
  }
  if (name === "show_preview") { switchPanel("preview"); return "Preview opened."; }
  throw new Error("Unknown tool: " + name);
}

const TOOL_GUIDE = `You are Pocket Agent, a practical coding assistant. You can use tools by outputting exactly one tool call in this format:
<tool_call>{"name":"write_file","arguments":{"path":"index.html","content":"..."} }</tool_call>
Available tools:
- list_files: no arguments
- read_file: {"path":"filename"}
- write_file: {"path":"filename","content":"full file content"}
- run_javascript: {"code":"JavaScript code"}
- run_python: {"code":"Python code"}
- show_preview: no arguments
If a task requires multiple files, make one tool call at a time, wait for its result, then continue. Use tools to actually create files and test code. When finished, explain what you made. Do not claim a tool ran unless you received its result. Keep code complete and avoid markdown fences inside tool calls.`;

function addMessage(role, content) {
  const welcome = document.querySelector(".welcome");
  if (welcome) welcome.remove();
  const wrap = document.createElement("div");
  wrap.className = "message " + role;
  const label = document.createElement("div"); label.className = "role"; label.textContent = role === "user" ? "You" : "Pocket Agent";
  const body = document.createElement("div"); body.className = "content"; body.textContent = content;
  wrap.append(label, body); $("#chat-log").appendChild(wrap);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
}
function parseToolCall(text) {
  const match = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!match) return null;
  try { return {call:JSON.parse(match[1]), rest:text.replace(match[0],"").trim()}; } catch { return null; }
}
async function askModel(messages) {
  const prompt = [{role:"system",content:TOOL_GUIDE},...messages]
    .map(m => `${m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User"}: ${m.content}`)
    .join("\n\n") + "\n\nAssistant:";
  const result = await model(prompt, {max_new_tokens:450,temperature:0.25,do_sample:true,return_full_text:false});
  return Array.isArray(result) ? result[0].generated_text : String(result);
}
let conversation = [];
async function handleSend(text) {
  if (!model) { addMessage("assistant","Load the local model first using the button at the top."); return; }
  if (busy) return;
  busy = true; $("#send-message").disabled = true; $("#working-indicator").hidden = false;
  conversation.push({role:"user",content:text});
  let current = text;
  try {
    for (let turn=0; turn<6; turn++) {
      const answer = await askModel(conversation);
      const parsed = parseToolCall(answer);
      if (!parsed) {
        const finalText = answer.trim() || "I couldn't produce a response. Try a shorter instruction.";
        conversation.push({role:"assistant",content:finalText});
        addMessage("assistant",finalText);
        break;
      }
      if (parsed.rest) addMessage("assistant",parsed.rest);
      const call = parsed.call;
      addMessage("assistant",`Using tool: ${call.name}`);
      let toolResult;
      try { toolResult = await executeTool(call.name,call.arguments || {}); }
      catch(e) { toolResult = "Tool error: " + e.message; }
      conversation.push({role:"assistant",content:answer});
      conversation.push({role:"user",content:`Tool result for ${call.name}: ${String(toolResult).slice(0,9000)}\nContinue the task. Use another tool if needed, otherwise give the final result.`});
      current = "";
    }
  } catch(e) {
    addMessage("assistant","I hit an error: " + (e?.message || e));
    log(e?.stack || e,"error");
  } finally {
    busy = false; $("#send-message").disabled = false; $("#working-indicator").hidden = true;
  }
}

async function loadModel() {
  const id = $("#model-id").value.trim();
  if (!id) return;
  $("#confirm-load-model").disabled = true;
  $("#model-progress").textContent = "Loading model library…";
  setStatus("Loading model…");
  try {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    model = await pipeline("text-generation", id, {
      device: navigator.gpu ? "webgpu" : "wasm",
      dtype: "q4",
      progress_callback: p => {
        if (p.status === "progress") $("#model-progress").textContent = `${p.file || "Model"} · ${Math.round(p.progress || 0)}%`;
        else if (p.status) $("#model-progress").textContent = p.status;
      }
    });
    $("#model-progress").textContent = "Model ready. You can start chatting.";
    setStatus("Model ready");
    $("#model-dialog").close();
    addMessage("assistant","I'm ready. Give me a task, and I can create project files and run JavaScript or Python in the browser sandbox.");
  } catch(e) {
    $("#model-progress").textContent = "Could not load model: " + (e?.message || e);
    setStatus("Model failed");
    log(e?.stack || e,"error");
  } finally { $("#confirm-load-model").disabled = false; }
}

document.querySelectorAll(".tab").forEach(t => t.addEventListener("click",()=>switchPanel(t.dataset.panel)));
$("#load-model").addEventListener("click",()=>$("#model-dialog").showModal());
$("#confirm-load-model").addEventListener("click",loadModel);
$("#cancel-model").addEventListener("click",()=>$("#model-dialog").close());
$("#chat-form").addEventListener("submit",e=>{
  e.preventDefault();
  const text=$("#message-input").value.trim();
  if (!text) return;
  $("#message-input").value="";
  addMessage("user",text);
  handleSend(text);
});
$("#message-input").addEventListener("keydown",e=>{
  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("#chat-form").requestSubmit();}
});
document.querySelectorAll(".starter").forEach(b=>b.addEventListener("click",()=>{
  $("#message-input").value=b.dataset.prompt; $("#message-input").focus();
}));
$("#save-file").addEventListener("click",saveActiveFile);
$("#run-js").addEventListener("click",async()=>{
  saveActiveFile();
  const code=activeFile.endsWith(".js")?projectFiles[activeFile]:$("#code-editor").value;
  log("Running JavaScript…");
  const r=await runJS(code);
  if(r.ok) r.output.forEach(x=>log(x)); else log(r.error,"error");
  switchPanel("console");
});
$("#run-python").addEventListener("click",async()=>{
  saveActiveFile(); log("Starting Python runtime (first start downloads Pyodide)…");
  const code=activeFile.endsWith(".py")?projectFiles[activeFile]:$("#code-editor").value;
  const r=await runPython(code);
  if(r.ok) log(r.output || "Python finished.","python"); else log(r.error,"error");
  switchPanel("console");
});
$("#refresh-preview").addEventListener("click",refreshPreview);
$("#clear-console").addEventListener("click",clearLog);
$("#new-file").addEventListener("click",()=>$("#file-dialog").showModal());
$("#create-file").addEventListener("click",()=>{
  const name=$("#new-file-name").value.trim();
  if(!name||name.includes("/")||name.includes("..")) return;
  if(name in projectFiles){alert("That file already exists.");return;}
  projectFiles[name]="";persist();$("#file-dialog").close();$("#new-file-name").value="";selectFile(name);
});
$("#new-project").addEventListener("click",()=>{
  if(!confirm("Reset this browser workspace to the starter files? This replaces the locally saved project.")) return;
  projectFiles=structuredClone(DEFAULT_FILES);activeFile="index.html";persist();renderFiles();selectFile(activeFile);$("#chat-log").innerHTML='<div class="welcome"><div class="welcome-icon">✳</div><h1>What are we building?</h1><p>Ask me to create files, write code, or run JavaScript and Python in the workspace sandbox.</p></div>';
});
$("#export-project").addEventListener("click",async()=>{
  saveActiveFile();
  if(!window.JSZip){alert("ZIP library did not load. Check your connection and try again.");return;}
  const zip=new JSZip();Object.entries(projectFiles).forEach(([name,content])=>zip.file(name,content));
  const blob=await zip.generateAsync({type:"blob"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="pocket-agent-project.zip";a.click();URL.revokeObjectURL(a.href);
});

renderFiles();selectFile(activeFile);persist();

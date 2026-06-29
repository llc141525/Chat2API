"""
Chat2API Model Test Suite
Tests DeepSeek V4 Pro, GLM-5.2, Qwen3.7-Max via Chat2API proxy.
Covers: tool calling, context memory, streaming.
Runs tests concurrently per model.
"""

import requests
import json
import time
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_URL = "http://127.0.0.1:8080/v1"
API_KEY = "sk-ugo4l2lb6p44K0pulK8RJQip1gIM4ydgOstOEMRkrah0QvR8"
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}

MODELS = ["deepseek-v4-pro", "GLM-5.2", "Qwen3.7-Max"]

TOOLS = [
    {"type": "function", "function": {"name": "read_file", "description": "Read content of a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "write_file", "description": "Write content to a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    {"type": "function", "function": {"name": "delete_file", "description": "Delete a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
]


def chat(model, messages, tools=None, stream=False, max_tokens=200):
    body = {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": stream}
    if tools:
        body["tools"] = tools
    r = requests.post(f"{BASE_URL}/chat/completions", headers=HEADERS, json=body, timeout=60)
    if stream:
        content = ""
        tool_calls = []
        for line in r.iter_lines():
            if not line: continue
            line = line.decode("utf-8")
            if line.startswith("data: "):
                data = line[6:]
                if data == "[DONE]": break
                try:
                    chunk = json.loads(data)
                    delta = chunk["choices"][0]["delta"]
                    if delta.get("content"): content += delta["content"]
                    if delta.get("tool_calls"): tool_calls.extend(delta["tool_calls"])
                except (json.JSONDecodeError, KeyError): pass
        return {"content": content, "tool_calls": tool_calls}
    data = r.json()
    if "error" in data: return {"error": data["error"]["message"]}
    msg = data["choices"][0]["message"]
    return {"content": msg.get("content"), "tool_calls": msg.get("tool_calls")}


# ── Test functions ──────────────────────────────────────────

def test_basic(model):
    r = chat(model, [{"role": "user", "content": "What is 2+2? Answer in one word."}])
    c = str(r.get("content", "")).strip().lower()
    return "4" in c or "four" in c

def test_tool_call(model):
    r = chat(model,
        [{"role": "system", "content": "Use tools when user asks to read/write/delete files. You MUST call the tool."},
         {"role": "user", "content": "Read the file /tmp/test.txt"}],
        tools=TOOLS, max_tokens=300)
    tc = r.get("tool_calls") or []
    return any(t.get("function", {}).get("name") == "read_file" for t in tc)

def test_multi_tool(model):
    r = chat(model,
        [{"role": "system", "content": "Use tools when needed. You can call multiple tools at once."},
         {"role": "user", "content": "Read /tmp/a.txt and /tmp/b.txt at the same time."}],
        tools=TOOLS, max_tokens=300)
    tc = r.get("tool_calls") or []
    return len([t for t in tc if t.get("function", {}).get("name") == "read_file"]) >= 2

def test_tool_roundtrip(model):
    r1 = chat(model,
        [{"role": "system", "content": "Use tools when needed."},
         {"role": "user", "content": "Read /tmp/hello.txt and tell me what it contains."}],
        tools=TOOLS, max_tokens=300)
    if not (r1.get("tool_calls") or []): return False
    r2 = chat(model,
        [{"role": "system", "content": "Use tools when needed."},
         {"role": "user", "content": "Read /tmp/hello.txt and tell me what it contains."},
         {"role": "assistant", "content": None, "tool_calls": r1["tool_calls"]},
         {"role": "tool", "content": "Hello World from Chat2API!", "tool_call_id": r1["tool_calls"][0]["id"]}],
        tools=TOOLS, max_tokens=300)
    return "hello world" in str(r2.get("content", "")).lower()

def test_context_memory(model):
    msgs = [
        {"role": "user", "content": "My name is Alice and I live in Paris."},
        {"role": "assistant", "content": "Nice to meet you Alice!"},
        {"role": "user", "content": "What is my name and where do I live?"},
    ]
    c = str(chat(model, msgs, max_tokens=100).get("content", "")).lower()
    return "alice" in c and "paris" in c

def test_stream(model):
    r = chat(model, [{"role": "user", "content": "Say hello in exactly 3 words."}], stream=True)
    content = str(r.get("content", "")).strip()
    return 2 <= len(content.split()) <= 6

def test_write_delete(model):
    r1 = chat(model,
        [{"role": "system", "content": "You MUST call tools, do not reply in text."},
         {"role": "user", "content": "Write 'test' to /tmp/log.txt"}],
        tools=TOOLS, max_tokens=300)
    r2 = chat(model,
        [{"role": "system", "content": "You MUST call tools, do not reply in text."},
         {"role": "user", "content": "Delete the file /tmp/log.txt"}],
        tools=TOOLS, max_tokens=300)
    return any("write_file" == (t.get("function", {}).get("name", "")) for t in (r1.get("tool_calls") or [])) and \
           any("delete_file" == (t.get("function", {}).get("name", "")) for t in (r2.get("tool_calls") or []))

def test_large_context(model):
    big = ("You are a helpful assistant. " * 200) + "The user's name is Bob."
    c = str(chat(model, [
        {"role": "system", "content": big},
        {"role": "user", "content": "What is my name?"},
    ], max_tokens=50).get("content", "")).lower()
    return "bob" in c


TESTS = [
    ("Basic Chat", test_basic),
    ("Tool Call", test_tool_call),
    ("Multi Tool", test_multi_tool),
    ("Tool Roundtrip", test_tool_roundtrip),
    ("Context Memory", test_context_memory),
    ("Streaming", test_stream),
    ("Write+Delete", test_write_delete),
    ("Large Context", test_large_context),
]


def run_one_test(model, name, fn):
    try:
        ok = fn(model)
        return name, ok, None, None
    except Exception as e:
        return name, False, str(e), None


def run_model_tests(model):
    """Run all tests for a model concurrently."""
    started = time.time()
    results = {}

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(run_one_test, model, name, fn): name for name, fn in TESTS}
        for future in as_completed(futures):
            name, ok, error, _ = future.result()
            if error:
                results[name] = (False, f"ERROR: {error}")
            else:
                results[name] = (ok, "PASS" if ok else "FAIL")

    elapsed = time.time() - started

    print(f"\n{'='*60}")
    print(f"  {model}  ({elapsed:.1f}s)")
    print(f"{'='*60}")
    passed = 0
    for name in [n for n, _ in TESTS]:
        ok, status = results.get(name, (False, "MISSING"))
        if ok: passed += 1
        mark = "[PASS]" if ok else "[FAIL]"
        print(f"  {mark} {name}: {status}")
    print(f"  ── {passed}/{len(TESTS)} passed")
    return passed, len(TESTS)


if __name__ == "__main__":
    print(f"Chat2API Model Test Suite (concurrent)")
    print(f"Proxy: {BASE_URL}")
    print(f"Models: {', '.join(MODELS)}")

    try:
        r = requests.get(f"{BASE_URL}/models", headers=HEADERS, timeout=5)
        if r.status_code != 200:
            print(f"ERROR: Proxy returned {r.status_code}")
            sys.exit(1)
    except requests.ConnectionError:
        print("ERROR: Cannot connect to proxy. Is Chat2API running?")
        sys.exit(1)

    total_start = time.time()
    total_pass = 0
    total_count = 0

    # Run all models concurrently
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(run_model_tests, m): m for m in MODELS}
        for future in as_completed(futures):
            p, t = future.result()
            total_pass += p
            total_count += t

    print(f"\n{'='*60}")
    print(f"  OVERALL: {total_pass}/{total_count} passed  ({time.time() - total_start:.1f}s)")
    print(f"{'='*60}")
    sys.exit(0 if total_pass == total_count else 1)

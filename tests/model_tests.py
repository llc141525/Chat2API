"""
Chat2API Model Test Suite
Tests DeepSeek V4 Pro, GLM-5.2, Qwen3.7-Max via Chat2API proxy.
Covers: tool calling, skill calling, context memory, streaming.
"""

import requests
import json
import time
import sys
import os

BASE_URL = "http://127.0.0.1:8080/v1"
API_KEY = "sk-ugo4l2lb6p44K0pulK8RJQip1gIM4ydgOstOEMRkrah0QvR8"
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}

MODELS = ["deepseek-v4-pro", "GLM-5.2", "Qwen3.7-Max"]

# ── Test Tools ──────────────────────────────────────────────
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read content of a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to read"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_file",
            "description": "Delete a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                },
                "required": ["path"],
            },
        },
    },
]


def chat(model, messages, tools=None, stream=False, max_tokens=200):
    """Send chat completion request."""
    body = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": stream,
    }
    if tools:
        body["tools"] = tools
    r = requests.post(
        f"{BASE_URL}/chat/completions",
        headers=HEADERS,
        json=body,
        timeout=60,
    )
    if stream:
        content = ""
        tool_calls = []
        for line in r.iter_lines():
            if not line:
                continue
            line = line.decode("utf-8")
            if line.startswith("data: "):
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                    delta = chunk["choices"][0]["delta"]
                    if delta.get("content"):
                        content += delta["content"]
                    if delta.get("tool_calls"):
                        tool_calls.extend(delta["tool_calls"])
                except (json.JSONDecodeError, KeyError):
                    pass
        return {"content": content, "tool_calls": tool_calls}
    else:
        data = r.json()
        if "error" in data:
            return {"error": data["error"]["message"]}
        msg = data["choices"][0]["message"]
        return {
            "content": msg.get("content"),
            "tool_calls": msg.get("tool_calls"),
        }


def test_basic(model):
    """Test 1: Basic chat response."""
    print(f"\n  [1] Basic chat...", end=" ")
    r = chat(model, [{"role": "user", "content": "What is 2+2? Answer in one word."}])
    content = str(r.get("content", "")).strip().lower()
    ok = "4" in content or "four" in content
    print("PASS" if ok else f"FAIL (got: {r})")
    return ok


def test_tool_call(model):
    """Test 2: Tool call - read_file."""
    print(f"  [2] Tool call (read_file)...", end=" ")
    r = chat(model,
        [{"role": "system", "content": "Use tools when user asks to read/write/delete files. You MUST call the tool, do not pretend."},
         {"role": "user", "content": "Read the file /tmp/test.txt"}],
        tools=TOOLS,
        max_tokens=300,
    )
    tc = r.get("tool_calls")
    if tc and len(tc) > 0:
        fn = tc[0].get("function", {})
        name = fn.get("name", "")
        if name == "read_file":
            print(f"PASS (called {name})")
            return True
    print(f"FAIL (got: {r})")
    return False


def test_multi_tool(model):
    """Test 3: Multiple tool calls in one turn."""
    print(f"  [3] Multi-tool call...", end=" ")
    r = chat(model,
        [{"role": "system", "content": "Use tools when needed. You can call multiple tools at once."},
         {"role": "user", "content": "Read /tmp/a.txt and /tmp/b.txt at the same time."}],
        tools=TOOLS,
        max_tokens=300,
    )
    tc = r.get("tool_calls") or []
    count = len([t for t in tc if t.get("function", {}).get("name") == "read_file"])
    ok = count >= 2
    print(f"PASS ({count} calls)" if ok else f"FAIL (got {count} calls: {r})")
    return ok


def test_tool_roundtrip(model):
    """Test 4: Tool roundtrip - model sees tool result and responds."""
    print(f"  [4] Tool roundtrip...", end=" ")
    # Step 1: ask model to read a file
    r1 = chat(model,
        [{"role": "system", "content": "Use tools when needed."},
         {"role": "user", "content": "Read the file /tmp/hello.txt and tell me what it contains."}],
        tools=TOOLS,
        max_tokens=300,
    )
    if not r1.get("tool_calls"):
        print(f"FAIL (no tool call: {r1})")
        return False

    # Step 2: provide tool result
    r2 = chat(model,
        [{"role": "system", "content": "Use tools when needed."},
         {"role": "user", "content": "Read the file /tmp/hello.txt and tell me what it contains."},
         {"role": "assistant", "content": None, "tool_calls": r1["tool_calls"]},
         {"role": "tool", "content": "Hello World from Chat2API!", "tool_call_id": r1["tool_calls"][0]["id"]}],
        tools=TOOLS,
        max_tokens=300,
    )
    content = str(r2.get("content", "")).lower()
    ok = "hello world" in content or "chat2api" in content
    print("PASS" if ok else f"FAIL (content: {content[:80]})")
    return ok


def test_context_memory(model):
    """Test 5: Context memory - multi-turn conversation."""
    print(f"  [5] Context memory...", end=" ")
    msgs = [
        {"role": "user", "content": "My name is Alice and I live in Paris."},
        {"role": "assistant", "content": "Nice to meet you Alice! Paris is a beautiful city."},
        {"role": "user", "content": "What is my name and where do I live?"},
    ]
    r = chat(model, msgs, max_tokens=100)
    content = str(r.get("content", "")).lower()
    ok = "alice" in content and "paris" in content
    print("PASS" if ok else f"FAIL (content: {content[:100]})")
    return ok


def test_stream(model):
    """Test 6: Streaming response."""
    print(f"  [6] Streaming...", end=" ")
    r = chat(model, [{"role": "user", "content": "Say hello in exactly 3 words."}], stream=True)
    content = str(r.get("content", "")).strip()
    word_count = len(content.split())
    ok = 2 <= word_count <= 6 and len(content) > 0
    print(f"PASS ({content[:50]})" if ok else f"FAIL (words: {word_count}, content: {content})")
    return ok


def test_tool_write_delete(model):
    """Test 7: Write and delete tool calls."""
    print(f"  [7] Write+Delete tools...", end=" ")
    r1 = chat(model,
        [{"role": "system", "content": "You MUST call tools, do not reply in text."},
         {"role": "user", "content": "Write 'test data' to /tmp/log.txt"}],
        tools=TOOLS,
        max_tokens=300,
    )
    tc1 = r1.get("tool_calls") or []
    write_ok = any(
        "write_file" == (t.get("function", {}).get("name", ""))
        for t in tc1
    )

    r2 = chat(model,
        [{"role": "system", "content": "You MUST call tools, do not reply in text."},
         {"role": "user", "content": "Delete the file /tmp/log.txt"}],
        tools=TOOLS,
        max_tokens=300,
    )
    tc2 = r2.get("tool_calls") or []
    delete_ok = any(
        "delete_file" == (t.get("function", {}).get("name", ""))
        for t in tc2
    )

    ok = write_ok and delete_ok
    details = []
    if write_ok:
        details.append("write OK")
    if delete_ok:
        details.append("delete OK")
    print(f"PASS ({', '.join(details)})" if ok else f"FAIL (write={write_ok}, delete={delete_ok})")
    return ok


def test_large_context(model):
    """Test 8: Large system prompt + user question (token limit test)."""
    print(f"  [8] Large system prompt...", end=" ")
    big_system = ("You are a helpful assistant. " * 200) + "The user's name is Bob."
    msgs = [
        {"role": "system", "content": big_system},
        {"role": "user", "content": "What is my name?"},
    ]
    r = chat(model, msgs, max_tokens=50)
    content = str(r.get("content", "")).lower()
    ok = "bob" in content and "hello" not in content[:10].lower()
    print("PASS" if ok else f"FAIL (content: {content[:80]})")
    return ok


def run_tests(model):
    """Run all tests for a single model."""
    print(f"\n{'='*60}")
    print(f"  Testing: {model}")
    print(f"{'='*60}")

    tests = [
        ("Basic Chat", test_basic),
        ("Tool Call", test_tool_call),
        ("Multi Tool", test_multi_tool),
        ("Tool Roundtrip", test_tool_roundtrip),
        ("Context Memory", test_context_memory),
        ("Streaming", test_stream),
        ("Write+Delete", test_tool_write_delete),
        ("Large Context", test_large_context),
    ]

    results = {}
    for name, fn in tests:
        try:
            results[name] = fn(model)
        except Exception as e:
            print(f"  ERROR: {e}")
            results[name] = False
        time.sleep(0.5)  # rate limit

    passed = sum(1 for v in results.values() if v)
    total = len(results)
    print(f"\n  Summary: {passed}/{total} passed")

    for name, ok in results.items():
        status = "PASS" if ok else "FAIL"
        print(f"    [{status}] {name}")

    return passed, total


if __name__ == "__main__":
    print("Chat2API Model Test Suite")
    print(f"Proxy: {BASE_URL}")
    print(f"Models: {', '.join(MODELS)}")

    # Check proxy is up
    try:
        r = requests.get(f"{BASE_URL}/models", headers=HEADERS, timeout=5)
        if r.status_code != 200:
            print(f"ERROR: Proxy returned {r.status_code}")
            sys.exit(1)
        print(f"Proxy: OK ({len(r.json()['data'])} models)")
    except requests.ConnectionError:
        print("ERROR: Cannot connect to proxy. Is Chat2API running?")
        sys.exit(1)

    all_passed = 0
    all_total = 0

    for model in MODELS:
        p, t = run_tests(model)
        all_passed += p
        all_total += t

    print(f"\n{'='*60}")
    print(f"  OVERALL: {all_passed}/{all_total} passed")
    print(f"{'='*60}")

    sys.exit(0 if all_passed == all_total else 1)

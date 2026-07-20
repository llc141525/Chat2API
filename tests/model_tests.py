"""
Chat2API Model Test Suite
Tests DeepSeek V4 Pro, GLM-5.2, Qwen3.7-Max via Chat2API proxy.
Covers: tool calling, context memory, streaming, multi-turn tool loops.
Runs tests concurrently per model.
"""

import os
import requests
import json
import time
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_URL = os.environ.get("CHAT2API_BASE_URL", "http://127.0.0.1:48763").rstrip("/") + "/v1"
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
    {"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}},
]


def chat(model, messages, tools=None, stream=False, max_tokens=300):
    body = {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": stream}
    if tools:
        body["tools"] = tools
    r = requests.post(f"{BASE_URL}/chat/completions", headers=HEADERS, json=body, timeout=60)
    if stream:
        content = ""
        tool_calls = []
        finish = None
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
                    if delta.get("tool_calls"):
                        for tc in delta["tool_calls"]:
                            idx = tc.get("index", 0)
                            while len(tool_calls) <= idx:
                                tool_calls.append({"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                            if tc.get("id"): tool_calls[idx]["id"] = tc["id"]
                            if tc.get("function", {}).get("name"): tool_calls[idx]["function"]["name"] += tc["function"]["name"]
                            if tc.get("function", {}).get("arguments"): tool_calls[idx]["function"]["arguments"] += tc["function"]["arguments"]
                    if chunk["choices"][0].get("finish_reason"): finish = chunk["choices"][0]["finish_reason"]
                except (json.JSONDecodeError, KeyError): pass
        return {"content": content, "tool_calls": tool_calls, "finish_reason": finish}
    data = r.json()
    if "error" in data: return {"error": data["error"]["message"]}
    msg = data["choices"][0]["message"]
    return {"content": msg.get("content"), "tool_calls": msg.get("tool_calls"), "finish_reason": data["choices"][0].get("finish_reason")}


# ── Single-turn tests ───────────────────────────────────────

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


# ── Multi-turn tests ─────────────────────────────────────────

def test_multi_turn_tool_loop(model, rounds=3):
    """Multi-turn tool loop: alternating tool calls and results across N rounds.
    Round 1: read file A -> Round 2: write based on A -> Round 3: read to verify.
    """
    msgs = [
        {"role": "system", "content": "Use tools when needed. Respond concisely."},
        {"role": "user", "content": "Read /tmp/config.json and tell me the value of 'theme' key."},
    ]
    tool_call_count = 0

    for _round in range(rounds):
        r = chat(model, msgs, tools=TOOLS, max_tokens=400)

        # If model returned tool calls, simulate tool result and continue
        if r.get("tool_calls"):
            tool_call_count += 1
            msgs.append({"role": "assistant", "content": r.get("content"), "tool_calls": r["tool_calls"]})
            # Simulate varied tool results per round
            simulated_results = ["dark mode", "blue theme with sidebar", "theme: ocean, font: roboto"]
            for tc in r["tool_calls"]:
                tid = tc.get("id", "")
                tname = tc.get("function", {}).get("name", "")
                if tname == "read_file":
                    result = simulated_results[_round % len(simulated_results)]
                elif tname == "write_file":
                    result = f"Written successfully"
                elif tname == "delete_file":
                    result = "Deleted"
                else:
                    result = f"Result for {tname}"
                msgs.append({"role": "tool", "content": result, "tool_call_id": tid})
            # Follow-up prompt for next round
            if _round == 0:
                msgs.append({"role": "user", "content": "Based on that config, write a new theme file to /tmp/theme-override.json with doubled font sizes."})
            elif _round == 1:
                msgs.append({"role": "user", "content": "Now read back /tmp/theme-override.json to verify the content was written."})
        else:
            # Model gave a text response - check if it references previous context
            content = str(r.get("content", "")).lower()
            msgs.append({"role": "assistant", "content": r.get("content")})
            if _round == 2:
                # After full round-trip, model should discuss theme-related content
                return "theme" in content or "font" in content or "dark" in content

    return tool_call_count >= 1


def test_streaming_tool_call(model):
    """Verify streaming mode correctly returns tool calls."""
    r = chat(model,
        [{"role": "system", "content": "You MUST call the tool when asked."},
         {"role": "user", "content": "Get the weather for Beijing."}],
        tools=TOOLS, stream=True, max_tokens=300)
    tc = r.get("tool_calls") or []
    # Streaming tool calls should accumulate properly
    has_weather = any("get_weather" == (t.get("function", {}).get("name", "")) for t in tc)
    has_finish = r.get("finish_reason") == "tool_calls"
    return has_weather and has_finish


def test_tool_result_context_usage(model):
    """Verify model actually uses tool result content in its response.
    Send tool call -> provide result -> expect model to reference result.
    """
    r1 = chat(model,
        [{"role": "system", "content": "Use tools. After receiving tool result, respond with the actual data from the result."},
         {"role": "user", "content": "What is the weather in Tokyo?"}],
        tools=TOOLS, max_tokens=300)
    tc = r1.get("tool_calls") or []
    if not tc: return False
    r2 = chat(model,
        [{"role": "system", "content": "Use tools. After receiving tool result, respond with the actual data from the result."},
         {"role": "user", "content": "What is the weather in Tokyo?"},
         {"role": "assistant", "content": None, "tool_calls": tc},
         {"role": "tool", "content": "Tokyo weather: 22°C, sunny, humidity 45%", "tool_call_id": tc[0]["id"]}],
        tools=TOOLS, max_tokens=300)
    content = str(r2.get("content", "")).lower()
    return (("22" in content and "sunny" in content) or "tokyo" in content)


def test_nonstream_tool_call(model):
    """Verify non-streaming mode correctly returns tool calls (no angle bracket leak)."""
    r = chat(model,
        [{"role": "system", "content": "You MUST call the tool when asked."},
         {"role": "user", "content": "Read /tmp/important.txt"}],
        tools=TOOLS, stream=False, max_tokens=300)
    tc = r.get("tool_calls") or []
    content = str(r.get("content", "") or "")
    # Tool calls MUST be in tool_calls field, NOT leaked into content as raw XML
    has_read = any("read_file" == (t.get("function", {}).get("name", "")) for t in tc)
    no_leak = "<|CHAT2API|" not in content and "<tool_calls>" not in content and "[function_calls]" not in content
    return has_read and no_leak


# ── Test registry ────────────────────────────────────────────

SINGLE_TURN_TESTS = [
    ("Basic Chat", test_basic),
    ("Tool Call", test_tool_call),
    ("Multi Tool", test_multi_tool),
    ("Tool Roundtrip", test_tool_roundtrip),
    ("Context Memory", test_context_memory),
    ("Streaming", test_stream),
    ("Write+Delete", test_write_delete),
    ("Large Context", test_large_context),
]

MULTI_TURN_TESTS = [
    ("Multi-Turn Tool Loop (3 rounds)", test_multi_turn_tool_loop),
    ("Streaming Tool Call", test_streaming_tool_call),
    ("Tool Result Context Usage", test_tool_result_context_usage),
    ("Non-Stream No Angle Bracket Leak", test_nonstream_tool_call),
]

ALL_TESTS = SINGLE_TURN_TESTS + MULTI_TURN_TESTS


def run_one_test(model, name, fn):
    try:
        ok = fn(model)
        return name, ok, None
    except Exception as e:
        return name, False, str(e)


def run_model_tests(model):
    """Run all tests for a model concurrently."""
    started = time.time()
    results = {}

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(run_one_test, model, name, fn): name for name, fn in ALL_TESTS}
        for future in as_completed(futures):
            name, ok, error = future.result()
            if error:
                results[name] = (False, f"ERROR: {error}")
            else:
                results[name] = (ok, "PASS" if ok else "FAIL")

    elapsed = time.time() - started

    print(f"\n{'='*60}")
    print(f"  {model}  ({elapsed:.1f}s)")
    print(f"{'='*60}")
    print(f"  ── Single-turn ──")
    passed = 0
    st_count = 0
    for name in [n for n, _ in SINGLE_TURN_TESTS]:
        ok, status = results.get(name, (False, "MISSING"))
        st_count += 1
        if ok: passed += 1
        mark = "[PASS]" if ok else "[FAIL]"
        print(f"  {mark} {name}: {status}")
    st_passed = passed
    st_total = st_count

    print(f"  ── Multi-turn ──")
    mt_passed = 0
    for name in [n for n, _ in MULTI_TURN_TESTS]:
        ok, status = results.get(name, (False, "MISSING"))
        st_count += 1
        if ok:
            passed += 1
            mt_passed += 1
        mark = "[PASS]" if ok else "[FAIL]"
        print(f"  {mark} {name}: {status}")
    mt_total = len(MULTI_TURN_TESTS)

    print(f"  ── {passed}/{len(ALL_TESTS)} passed (single: {st_passed}/{st_total}, multi: {mt_passed}/{mt_total})")
    return passed, len(ALL_TESTS)


if __name__ == "__main__":
    print(f"Chat2API Model Test Suite (concurrent)")
    print(f"Proxy: {BASE_URL}")
    print(f"Models: {', '.join(MODELS)}")
    print(f"Tests: {len(SINGLE_TURN_TESTS)} single-turn + {len(MULTI_TURN_TESTS)} multi-turn = {len(ALL_TESTS)} total")

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

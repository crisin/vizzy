"""Stand-in for ComfyUI, just enough of the API for the bake client.

Speaks the four endpoints src/comfy.rs uses — /system_stats, /upload/image,
/prompt, /history/<id>, /view — with the response shapes a real ComfyUI
returns. It runs no model: the "depth map" it hands back is a fixed PNG, so
the test checks the transport, not the inference.

Started by tests/comfy_mock.rs; prints the port it bound to on stdout.
"""

import json
import re
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

# 1x1 grey PNG — stands in for a baked depth map
DEPTH_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000"
    "00907753de0000000c4944415408d76360606000000005000157a1f4"
    "3c0000000049454e44ae426082"
)

# prompt_id -> [polls still answered as "not there yet", images the run saved]
# so the client's polling loop is actually exercised
PENDING = {}
BATCH = {}
UPLOADS = {}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # keep the test output readable

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/system_stats":
            return self._json(
                200,
                {
                    "system": {"comfyui_version": "0.3.99-mock"},
                    "devices": [{"name": "mock device"}],
                },
            )

        m = re.fullmatch(r"/history/([\w-]+)", url.path)
        if m:
            prompt_id = m.group(1)
            with LOCK:
                left = PENDING.get(prompt_id)
                if left is None:
                    return self._json(200, {})  # unknown id
                if left > 0:
                    PENDING[prompt_id] = left - 1
                    return self._json(200, {})  # still queued
                count = BATCH.get(prompt_id, 1)
            # a batched sampler saves the whole batch under one node, in order
            images = [
                {
                    "filename": "vizzy_out_%05d_.png" % (i + 1),
                    "subfolder": "",
                    "type": "output",
                }
                for i in range(count)
            ]
            return self._json(
                200,
                {
                    prompt_id: {
                        "status": {"completed": True},
                        "outputs": {"3": {"images": images}},
                    }
                },
            )

        if url.path == "/view":
            q = parse_qs(url.query)
            if not re.fullmatch(
                r"vizzy_out_\d{5}_\.png", q.get("filename", [""])[0]
            ):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(DEPTH_PNG)))
            self.end_headers()
            self.wfile.write(DEPTH_PNG)
            return

        self.send_error(404)

    def do_POST(self):
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        if url.path == "/upload/image":
            # crude multipart read: we only need the filename back
            m = re.search(rb'name="image"; filename="([^"]+)"', body)
            if not m:
                return self._json(400, {"error": "no image part"})
            name = m.group(1).decode()
            with LOCK:
                UPLOADS[name] = len(body)
            return self._json(200, {"name": name, "subfolder": "", "type": "input"})

        if url.path == "/prompt":
            payload = json.loads(body)
            prompt = payload.get("prompt") or {}
            # mimic ComfyUI rejecting a workflow whose node class is unknown
            for node_id, node in prompt.items():
                if node.get("class_type") == "DoesNotExist":
                    return self._json(
                        400,
                        {
                            "error": {"type": "invalid_prompt", "message": "unknown node"},
                            "node_errors": {node_id: ["class not found"]},
                        },
                    )
            # the LoadImage node must point at something we actually received
            load = next(
                (n for n in prompt.values() if n.get("class_type") == "LoadImage"), None
            )
            if load is not None:
                with LOCK:
                    if load["inputs"]["image"] not in UPLOADS:
                        return self._json(
                            400,
                            {
                                "error": {"message": "image not in input folder"},
                                "node_errors": {},
                            },
                        )
            # a RepeatLatentBatch in the workflow means the run saves a batch
            repeat = next(
                (
                    n
                    for n in prompt.values()
                    if n.get("class_type") == "RepeatLatentBatch"
                ),
                None,
            )
            count = int(repeat["inputs"]["amount"]) if repeat else 1
            prompt_id = str(uuid.uuid4())
            with LOCK:
                PENDING[prompt_id] = 2  # make the client poll a couple of times
                BATCH[prompt_id] = count
            return self._json(200, {"prompt_id": prompt_id, "number": 1})

        self.send_error(404)


def main():
    server = HTTPServer(("127.0.0.1", 0), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())

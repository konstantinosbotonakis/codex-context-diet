#!/usr/bin/env python3
"""
Laya worker for Codex Context Diet.

Two modes:

  serve  a unix-socket daemon that loads the model once and answers requests
  ask    a one-shot request on stdin, for tests and for the first warm-up

The protocol is newline-delimited JSON, one request and one response per line:

  {"op": "ping"}                                  -> model, device, loaded
  {"op": "ask", "state": ..., "questions": {...}} -> Laya answers plus usage
  {"op": "stop"}                                  -> the daemon exits

Question and answer shapes are Laya's own, which match the plugin's: noul,
choice and score, each with calibrated probabilities.
"""
import argparse
import json
import os
import socket
import sys
import time


def log(message):
    print(message, file=sys.stderr, flush=True)


class Engine:
    """Loads the checkpoint once and answers with it."""

    def __init__(self, model, subfolder, device):
        self.model_id = model
        self.subfolder = subfolder or None
        self.device = device or None
        self.agent = None
        self.loaded_at = None

    def load(self):
        if self.agent is not None:
            return
        import laya

        started = time.time()
        self.agent = laya.load(self.model_id, device=self.device, subfolder=self.subfolder)
        self.loaded_at = time.time()
        log('laya: loaded %s%s in %.1fs on %s' % (
            self.model_id,
            '/' + self.subfolder if self.subfolder else '',
            self.loaded_at - started,
            self.agent.device,
        ))

    def info(self):
        import laya

        return {
            'laya': getattr(laya, '__version__', 'unknown'),
            'model': self.model_id,
            'subfolder': self.subfolder,
            'device': str(self.agent.device) if self.agent is not None else self.device,
            'loaded': self.agent is not None,
        }

    def ask(self, state, questions):
        self.load()
        result = self.agent.system_one(state, questions)
        return {
            'answers': result.get('answers', {}),
            'usage': result.get('usage', {}),
            'model': 'laya/' + self.model_id + (('/' + self.subfolder) if self.subfolder else ''),
        }


def handle(engine, request):
    op = request.get('op', 'ask')
    if op == 'ping':
        return {'ok': True, **engine.info()}
    if op == 'warm':
        engine.load()
        return {'ok': True, **engine.info()}
    if op == 'stop':
        return {'ok': True, 'stopping': True}
    if op == 'ask':
        state = request.get('state')
        questions = request.get('questions') or {}
        if not isinstance(questions, dict) or not questions:
            return {'error': 'questions must be a non-empty object'}
        try:
            return {'ok': True, **engine.ask(state, questions)}
        except Exception as error:  # noqa: BLE001 - the client turns this into a keep
            return {'error': str(error)[:400]}
    return {'error': 'unknown op: ' + str(op)[:40]}


def serve(engine, socket_path, preload):
    if preload:
        engine.load()
    if os.path.exists(socket_path):
        os.unlink(socket_path)
    os.makedirs(os.path.dirname(socket_path), exist_ok=True)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_path)
    server.listen(8)
    log('laya: listening on ' + socket_path)
    while True:
        connection, _ = server.accept()
        stop = False
        with connection:
            reader = connection.makefile('r', encoding='utf-8')
            writer = connection.makefile('w', encoding='utf-8')
            try:
                lines = reader
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        request = json.loads(line)
                    except ValueError:
                        writer.write(json.dumps({'error': 'invalid json'}) + '\n')
                        writer.flush()
                        continue
                    response = handle(engine, request)
                    writer.write(json.dumps(response) + '\n')
                    writer.flush()
                    if response.get('stopping'):
                        stop = True
                        break
            finally:
                # makefile duplicates the descriptor, so closing the socket is
                # not enough: the peer would never see the connection close.
                reader.close()
                writer.close()
        if stop:
            break
    server.close()
    if os.path.exists(socket_path):
        os.unlink(socket_path)


def main():
    parser = argparse.ArgumentParser(description='Laya worker for Codex Context Diet')
    parser.add_argument('mode', choices=['serve', 'ask'])
    parser.add_argument('--socket', default='')
    parser.add_argument('--model', default='convaiinnovations/laya')
    parser.add_argument('--subfolder', default='multilingual')
    parser.add_argument('--device', default='')
    parser.add_argument('--preload', action='store_true')
    args = parser.parse_args()

    engine = Engine(args.model, args.subfolder, args.device)
    if args.mode == 'ask':
        request = json.loads(sys.stdin.read() or '{}')
        response = handle(engine, {**request, 'op': request.get('op', 'ask')})
        sys.stdout.write(json.dumps(response) + '\n')
        return 0 if 'error' not in response else 1
    if not args.socket:
        log('serve mode needs --socket')
        return 2
    serve(engine, args.socket, args.preload)
    return 0


if __name__ == '__main__':
    sys.exit(main())

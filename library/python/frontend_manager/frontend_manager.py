import os
from typing import Any, Dict, Optional

try:
    from ..rtms_manager.utils.logger import FileLogger
except ImportError:
    from rtms_manager.utils.logger import FileLogger


class FrontendManager:
    """Serve static frontend assets and resolve the frontend WebSocket URL."""

    def __init__(
        self,
        static_path: Optional[str] = None,
        views_path: Optional[str] = None,
        frontend_wss_path: str = '/ws',
        frontend_wss_url: Optional[str] = None,
        serve_static_enabled: bool = True,
        port: int = 3000,
        logger: Any = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        cfg = config or {}
        self.config = cfg
        self.views_path = cfg.get('views_path', cfg.get('viewsPath', views_path))
        self.static_path = cfg.get('static_path', cfg.get('staticPath', static_path))
        self.frontend_wss_path = cfg.get('frontend_wss_path', cfg.get('frontendWssPath', frontend_wss_path))
        self.frontend_wss_url = cfg.get('frontend_wss_url', cfg.get('frontendWssUrl', frontend_wss_url))
        self.serve_static_enabled = cfg.get(
            'serve_static_enabled',
            cfg.get('serveStaticEnabled', serve_static_enabled),
        )
        self.port = cfg.get('port', port)
        self.logger = logger or FileLogger

    def resolve_public_path(self) -> Optional[str]:
        if self.static_path:
            return self.static_path
        if self.views_path:
            if os.path.basename(os.path.normpath(self.views_path)) == 'views':
                return os.path.dirname(os.path.normpath(self.views_path))
            return self.views_path
        return None

    def resolve_websocket_url(
        self,
        host: Optional[str] = None,
        is_secure: bool = False,
        forwarded_proto: Optional[str] = None,
    ) -> str:
        ws_url = self.frontend_wss_url
        if isinstance(ws_url, str) and (ws_url.startswith('ws://') or ws_url.startswith('wss://')):
            return ws_url

        resolved_host = host or f'localhost:{self.port}'
        secure = (
            bool(is_secure)
            or str(forwarded_proto or '').lower() == 'https'
            or ('localhost' not in resolved_host and '127.0.0.1' not in resolved_host)
        )
        protocol = 'wss' if secure else 'ws'
        return f'{protocol}://{resolved_host}{self.frontend_wss_path}'

    def setup_flask(self, app):
        if not app:
            self.logger.warn('[FrontendManager] No Flask app provided. Skipping frontend setup.')
            return
        if self.serve_static_enabled is False:
            self.logger.info('[FrontendManager] Static file serving disabled.')
            return

        from flask import request, send_from_directory, render_template

        public_path = self.resolve_public_path()
        if public_path and os.path.isdir(public_path):
            @app.route('/static/<path:filename>')
            def frontend_static(filename):
                return send_from_directory(public_path, filename)

        @app.route('/', methods=['GET'])
        def frontend_index():
            ws_url = self.resolve_websocket_url(
                host=request.headers.get('Host'),
                is_secure=request.is_secure,
                forwarded_proto=request.headers.get('X-Forwarded-Proto'),
            )
            if self.views_path and os.path.isfile(os.path.join(self.views_path, 'index.html')):
                return render_template('index.html', websocket_url=ws_url, websocketUrl=ws_url)
            return {'websocketUrl': ws_url}

        self.logger.info(f'[FrontendManager] Flask frontend routes configured (ws path: {self.frontend_wss_path})')

    def setup_fastapi(self, app):
        if not app:
            self.logger.warn('[FrontendManager] No FastAPI app provided. Skipping frontend setup.')
            return
        if self.serve_static_enabled is False:
            self.logger.info('[FrontendManager] Static file serving disabled.')
            return

        from fastapi import Request
        from fastapi.responses import HTMLResponse, JSONResponse
        from fastapi.staticfiles import StaticFiles

        public_path = self.resolve_public_path()
        if public_path and os.path.isdir(public_path):
            app.mount('/static', StaticFiles(directory=public_path), name='frontend-static')

        @app.get('/')
        async def frontend_index(request: Request):
            ws_url = self.resolve_websocket_url(
                host=request.headers.get('host'),
                is_secure=request.url.scheme == 'https',
                forwarded_proto=request.headers.get('x-forwarded-proto'),
            )
            if self.views_path:
                index_file = os.path.join(self.views_path, 'index.html')
                if os.path.isfile(index_file):
                    with open(index_file, 'r', encoding='utf-8') as f:
                        html = f.read().replace('{{websocketUrl}}', ws_url).replace('{{ websocket_url }}', ws_url)
                    return HTMLResponse(content=html)
            return JSONResponse(content={'websocketUrl': ws_url})

        self.logger.info(f'[FrontendManager] FastAPI frontend routes configured (ws path: {self.frontend_wss_path})')

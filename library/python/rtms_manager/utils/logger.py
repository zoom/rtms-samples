import logging
import os
from datetime import datetime
from typing import Any, Dict, Optional


class FileLogger:
    _instance: Optional['FileLogger'] = None
    _level: str = 'info'
    _log_dir: Optional[str] = None
    _console_output: bool = True
    _file_output: bool = True
    _logger: Optional[logging.Logger] = None
    _sinks: Dict[str, Any] = {}

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    @classmethod
    def set_level(cls, level: str):
        cls._level = str(level or 'off').lower()
        if cls._logger:
            cls._logger.setLevel(cls._get_log_level())

    @classmethod
    def set_log_dir(cls, log_dir: str):
        cls._log_dir = log_dir
        os.makedirs(log_dir, exist_ok=True)
        cls._setup_logger()

    @classmethod
    def set_console_output(cls, enabled: bool):
        cls._console_output = bool(enabled)
        cls._setup_logger()

    @classmethod
    def set_file_output(cls, enabled: bool):
        cls._file_output = bool(enabled)
        cls._setup_logger()

    @classmethod
    def add_sink(cls, name: str, sink: Any):
        cls._sinks[name] = sink

    @classmethod
    def remove_sink(cls, name: str):
        cls._sinks.pop(name, None)

    @classmethod
    def _get_log_level(cls) -> int:
        levels = {
            'off': logging.CRITICAL + 1,
            'error': logging.ERROR,
            'warn': logging.WARNING,
            'warning': logging.WARNING,
            'info': logging.INFO,
            'debug': logging.DEBUG,
        }
        return levels.get(cls._level, logging.INFO)

    @classmethod
    def _setup_logger(cls):
        cls._logger = logging.getLogger('rtms')
        cls._logger.setLevel(cls._get_log_level())
        cls._logger.handlers.clear()

        formatter = logging.Formatter(
            '%(asctime)s [%(levelname)s] %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )

        if cls._console_output:
            console_handler = logging.StreamHandler()
            console_handler.setFormatter(formatter)
            cls._logger.addHandler(console_handler)

        if cls._file_output and cls._log_dir:
            log_file = os.path.join(
                cls._log_dir,
                f"rtms_{datetime.now().strftime('%Y%m%d')}.log"
            )
            file_handler = logging.FileHandler(log_file)
            file_handler.setFormatter(formatter)
            cls._logger.addHandler(file_handler)

    @classmethod
    def _ensure_logger(cls) -> logging.Logger:
        if cls._logger is None:
            cls._setup_logger()
        return cls._logger  # type: ignore

    @classmethod
    def _forward_sinks(cls, method: str, message: str, *args):
        formatted = message % args if args else message
        for sink in list(cls._sinks.values()):
            fn = getattr(sink, method, None) or getattr(sink, 'log', None)
            if callable(fn):
                try:
                    fn(formatted)
                except Exception:
                    pass

    @classmethod
    def log(cls, message: str, *args):
        cls._ensure_logger().info(message, *args)
        cls._forward_sinks('log', message, *args)

    @classmethod
    def info(cls, message: str, *args):
        cls._ensure_logger().info(message, *args)
        cls._forward_sinks('info', message, *args)

    @classmethod
    def warn(cls, message: str, *args):
        cls._ensure_logger().warning(message, *args)
        cls._forward_sinks('warn', message, *args)

    @classmethod
    def warning(cls, message: str, *args):
        cls._ensure_logger().warning(message, *args)
        cls._forward_sinks('warn', message, *args)

    @classmethod
    def error(cls, message: str, *args):
        cls._ensure_logger().error(message, *args)
        cls._forward_sinks('error', message, *args)

    @classmethod
    def debug(cls, message: str, *args):
        cls._ensure_logger().debug(message, *args)
        cls._forward_sinks('debug', message, *args)

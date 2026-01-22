import logging
import os
from datetime import datetime
from typing import Optional


class FileLogger:
    _instance: Optional['FileLogger'] = None
    _level: str = 'info'
    _log_dir: Optional[str] = None
    _logger: Optional[logging.Logger] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    @classmethod
    def set_level(cls, level: str):
        cls._level = level.lower()
        if cls._logger:
            cls._logger.setLevel(cls._get_log_level())

    @classmethod
    def set_log_dir(cls, log_dir: str):
        cls._log_dir = log_dir
        os.makedirs(log_dir, exist_ok=True)
        cls._setup_logger()

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

        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        cls._logger.addHandler(console_handler)

        if cls._log_dir:
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
    def log(cls, message: str, *args):
        cls._ensure_logger().info(message, *args)

    @classmethod
    def info(cls, message: str, *args):
        cls._ensure_logger().info(message, *args)

    @classmethod
    def warn(cls, message: str, *args):
        cls._ensure_logger().warning(message, *args)

    @classmethod
    def warning(cls, message: str, *args):
        cls._ensure_logger().warning(message, *args)

    @classmethod
    def error(cls, message: str, *args):
        cls._ensure_logger().error(message, *args)

    @classmethod
    def debug(cls, message: str, *args):
        cls._ensure_logger().debug(message, *args)

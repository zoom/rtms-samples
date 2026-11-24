"""URL allowlist tests: run with `python3 -m unittest discover -s tests` from library/python."""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from rtms_manager.utils.url_policy import (  # noqa: E402
    is_allowed_rtms_callback_url,
    select_allowed_rtms_callback_url,
)


class UrlPolicyTest(unittest.TestCase):
    def test_accepts_zoom_us_wss_endpoints(self):
        self.assertTrue(is_allowed_rtms_callback_url('wss://rwcpdns1sjc.zoom.us/ws'))
        self.assertTrue(is_allowed_rtms_callback_url('wss://zoom.us/ws'))
        self.assertTrue(is_allowed_rtms_callback_url('ws://media.zoom.us/ws'))

    def test_rejects_malformed_or_non_zoom_hosts(self):
        self.assertFalse(is_allowed_rtms_callback_url('http://169.254.169.254/'))
        self.assertFalse(is_allowed_rtms_callback_url('https://zoom.us/ws'))
        self.assertFalse(is_allowed_rtms_callback_url('wss://evil.example.com/ws'))
        self.assertFalse(is_allowed_rtms_callback_url('wss://notzoom.us/ws'))
        self.assertFalse(is_allowed_rtms_callback_url('not a url'))
        self.assertFalse(is_allowed_rtms_callback_url(''))
        self.assertFalse(is_allowed_rtms_callback_url('wss://zoom.us/' + 'a' * 2100))

    def test_honors_custom_allowlists(self):
        self.assertTrue(is_allowed_rtms_callback_url('wss://media.corp.internal/ws', ['corp.internal']))
        self.assertFalse(is_allowed_rtms_callback_url('wss://media.corp.internal/ws', ['other.internal']))

    def test_honors_env_override(self):
        with patch.dict(os.environ, {'RTMS_ALLOWED_MEDIA_HOSTS': 'custom.example, lab.local'}):
            self.assertTrue(is_allowed_rtms_callback_url('wss://rtms.custom.example/ws'))
            self.assertTrue(is_allowed_rtms_callback_url('wss://lab.local/ws'))
            self.assertFalse(is_allowed_rtms_callback_url('wss://rwcp.zoom.us/ws'))

    def test_selects_allowed_wss_from_comma_separated_list(self):
        self.assertEqual(
            select_allowed_rtms_callback_url('srt://media.zoom.us:9000, wss://signal.zoom.us/ws'),
            'wss://signal.zoom.us/ws',
        )
        self.assertIsNone(select_allowed_rtms_callback_url('srt://media.zoom.us:9000'))
        self.assertIsNone(select_allowed_rtms_callback_url('wss://evil.example.com/ws, srt://media.zoom.us:9000'))


if __name__ == '__main__':
    unittest.main()

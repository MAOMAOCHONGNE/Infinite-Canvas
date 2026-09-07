import logging
import unittest

import main


class QuietAccessLogFilterTests(unittest.TestCase):
    def setUp(self):
        self.filter = main.QuietAccessLogFilter()

    @staticmethod
    def record(args=(), message='%s - "%s %s HTTP/%s" %d'):
        return logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg=message,
            args=args,
            exc_info=None,
        )

    def test_hides_304_access_record(self):
        record = self.record(("127.0.0.1:1234", "GET", "/static/example.png", "1.1", 304))

        self.assertFalse(self.filter.filter(record))

    def test_hides_preformatted_304_access_record(self):
        record = self.record((), '127.0.0.1:1234 - "GET /static/example.png HTTP/1.1" 304')

        self.assertFalse(self.filter.filter(record))

    def test_keeps_real_client_and_server_errors(self):
        not_found = self.record(("127.0.0.1:1234", "GET", "/missing.png", "1.1", 404))
        server_error = self.record(("127.0.0.1:1234", "GET", "/api/test", "1.1", 500))

        self.assertTrue(self.filter.filter(not_found))
        self.assertTrue(self.filter.filter(server_error))


if __name__ == "__main__":
    unittest.main()

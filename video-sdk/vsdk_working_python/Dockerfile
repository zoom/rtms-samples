# Python Video SDK RTMS webhook and media receiver.
FROM python:3.12-slim AS dependencies
ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
WORKDIR /app
COPY video-sdk/vsdk_working_python/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY video-sdk/vsdk_working_python ./

FROM python:3.12-slim AS runtime
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=dependencies /opt/venv /opt/venv
COPY --from=dependencies --chown=nobody:nogroup /app /app
USER nobody
EXPOSE 3000
CMD ["gunicorn", "--bind", "0.0.0.0:3000", "index:app"]

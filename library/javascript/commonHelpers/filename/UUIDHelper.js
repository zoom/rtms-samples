export class UUIDHelper {
    /**
     * Sanitizes a UUID by replacing non-alphanumeric characters with underscores.
     * @param {string} uuid - The UUID to sanitize.
     * @returns {string} The sanitized UUID.
     */
    static sanitize(uuid) {
        if (!uuid) return '';
        return uuid.replace(/[^a-zA-Z0-9]/g, '_');
    }
}

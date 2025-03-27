/*
--------------------------------------------------------------------------
                            README / IMPORTANT
--------------------------------------------------------------------------

1.  **HTML Structure Required:** This JavaScript code assumes a specific HTML
    structure exists with the following element IDs and classes:
    - A container for theme switching: `.page`
    - Input fields: `#password`, `#reason` (or others for persistence)
    - Buttons: `#enable-refresh`, `#toggle-theme`
    - A popup display area: `.popup`, `#response`
    - Connection status display: `#connection-status`
    - Generic data display area: `#data-display`
    You MUST create these elements in your HTML file for the UI interactions
    and displays to work correctly. Basic CSS is also needed for theme
    toggling (.page_light, .theme-toggle-btn_light) and popup visibility
    (.popup_slide, .popup_error).

2.  **Connection Check Target:** The `ConnectionMonitor` uses a placeholder
    URL (`'internal-probe'`) which triggers its internal simulation
    (`_simulateFetch`). For real-world use, replace `'internal-probe'` with
    an actual, lightweight URL on your server (e.g., a health check endpoint
    like '/api/health' or even just '/favicon.ico' if appropriate) and
    remove or comment out the `_simulateFetch` method within the
    `ConnectionMonitor` class. Ensure the target URL endpoint supports the chosen
    `httpMethod` (default 'HEAD') and CORS if accessing cross-domain.

3.  **Complexity:** This code includes a detailed `ConnectionMonitor` with
    multiple states, exponential backoff, jitter, error handling, and event
    dispatching. The application logic integrates this monitor, handles UI
    updates, data refresh cycles, user input persistence (localStorage), and
    theme switching.

4.  **No External Libraries:** This code uses standard browser APIs only.

--------------------------------------------------------------------------
*/

// Wrap everything in an IIFE to create a private scope
(function() {
    'use strict';

    // --- ConnectionMonitor Class Definition ---
    /**
     * @fileoverview Monitors network connection status by periodically checking a target URL.
     * Dispatches events when the connection state changes or checks fail.
     */

    /**
     * Monitors network connectivity by periodically fetching a target URL.
     * It tracks connection state (UNKNOWN, CONNECTING, ONLINE, OFFLINE, DEGRADED, SLOW)
     * and provides events for state changes and errors.
     * Uses a simulated fetch for demonstration purposes.
     *
     * @extends EventTarget
     *
     * @fires ConnectionMonitor#statechange - Dispatched when the connection state changes.
     * @fires ConnectionMonitor#error - Dispatched whenever a check fails (excluding intentional aborts).
     * @fires ConnectionMonitor#checkfailed - Dispatched when a check fails while the state is already OFFLINE.
     */
    class ConnectionMonitor extends EventTarget {
        /**
         * Enum for possible connection states.
         * @readonly
         * @enum {string}
         */
        static States = Object.freeze({
            UNKNOWN: 'UNKNOWN',       // Initial state or state after stopping.
            CONNECTING: 'CONNECTING', // Actively trying to establish a connection after being offline or starting.
            ONLINE: 'ONLINE',         // Connection is active and latency is within acceptable limits.
            OFFLINE: 'OFFLINE',       // Connection is confirmed to be down after consecutive failures.
            DEGRADED: 'DEGRADED',     // Connection is experiencing high latency, timeouts, or server errors (5xx).
            SLOW: 'SLOW',           // Connection is active but latency exceeds the 'slow' threshold.
        });

        /**
         * Creates an instance of ConnectionMonitor.
         *
         * @param {string} targetUrl - The URL to periodically check for connectivity. Must be accessible via fetch. Use 'internal-probe' to use simulation.
         * @param {object} [options={}] - Configuration options for the monitor.
         * @param {number} [options.checkInterval=5000] - Interval (ms) between checks when potentially online. Must be >= 0.
         * @param {number} [options.offlineCheckInterval=10000] - Base interval (ms) between checks when OFFLINE. Exponential backoff applied. Must be >= 0.
         * @param {number} [options.maxOfflineCheckInterval=60000] - Max interval (ms) for offline checks after backoff. Must be >= offlineCheckInterval.
         * @param {number} [options.backoffExponentCap=5] - Exponent cap for offline backoff (2^cap). Must be > 0.
         * @param {number} [options.timeout=4000] - Timeout (ms) for each check request. Must be >= 0.
         * @param {number} [options.latencyThresholdSlow=1500] - Latency (ms) above which is SLOW. Must be >= 0.
         * @param {number} [options.latencyThresholdDegraded=3000] - Latency threshold used with timeouts/errors for DEGRADED state. Must be >= latencyThresholdSlow.
         * @param {number} [options.consecutiveFailuresThreshold=3] - Failures to go OFFLINE. Must be > 0.
         * @param {number} [options.consecutiveSuccessesThreshold=2] - Successes to recover from OFFLINE/CONNECTING. Must be > 0.
         * @param {'HEAD'|'GET'|'OPTIONS'} [options.httpMethod='HEAD'] - HTTP method for checks.
         * @param {boolean} [options.checkNavigatorOnLine=true] - Checks `navigator.onLine` before fetch.
         * @param {Record<string, string>} [options.headers={}] - Custom headers for fetch.
         *
         * @throws {Error} If validation fails.
         */
        constructor(targetUrl, options = {}) {
            super();

            if (!targetUrl || typeof targetUrl !== 'string') {
                throw new Error('ConnectionMonitor requires a valid targetUrl string.');
            }
            this.targetUrl = targetUrl; // Store targetUrl

            const defaultOptions = {
                checkInterval: 5000,
                offlineCheckInterval: 10000,
                maxOfflineCheckInterval: 60000,
                backoffExponentCap: 5, // Max multiplier 2^5 = 32
                timeout: 4000,
                latencyThresholdSlow: 1500,
                latencyThresholdDegraded: 3000,
                consecutiveFailuresThreshold: 3,
                consecutiveSuccessesThreshold: 2,
                httpMethod: 'HEAD',
                checkNavigatorOnLine: true,
                headers: {},
            };

            this.options = {
                ...defaultOptions,
                ...(options || {}),
            };

            // --- Option Validation ---
            Object.entries(this.options).forEach(([key, val]) => {
                if (typeof val === 'number') {
                    if (val < 0 || !Number.isFinite(val)) {
                        throw new Error(`Option '${key}' must be a non-negative finite number. Received: ${val}`);
                    }
                    // Check integer constraints for specific options
                    if (['consecutiveFailuresThreshold', 'consecutiveSuccessesThreshold', 'backoffExponentCap'].includes(key)) {
                        if (!Number.isInteger(val) || val <= 0) {
                            throw new Error(`Option '${key}' must be a positive integer. Received: ${val}`);
                        }
                    }
                } else if (key === 'httpMethod' && !['HEAD', 'GET', 'OPTIONS'].includes(val)) {
                     throw new Error(`Option 'httpMethod' must be one of 'HEAD', 'GET', 'OPTIONS'. Received: ${val}`);
                } else if (key === 'headers' && typeof val !== 'object') {
                     throw new Error(`Option 'headers' must be an object. Received: ${typeof val}`);
                } else if (key === 'checkNavigatorOnLine' && typeof val !== 'boolean') {
                     throw new Error(`Option 'checkNavigatorOnLine' must be a boolean. Received: ${typeof val}`);
                }
            });

            if (this.options.latencyThresholdDegraded < this.options.latencyThresholdSlow) {
                throw new Error(`Option 'latencyThresholdDegraded' (${this.options.latencyThresholdDegraded}) must be >= 'latencyThresholdSlow' (${this.options.latencyThresholdSlow}).`);
            }
            if (this.options.maxOfflineCheckInterval < this.options.offlineCheckInterval) {
                throw new Error(`Option 'maxOfflineCheckInterval' (${this.options.maxOfflineCheckInterval}) must be >= 'offlineCheckInterval' (${this.options.offlineCheckInterval}).`);
            }
            if (this.options.timeout > this.options.checkInterval) {
                console.warn(`ConnectionMonitor: Option 'timeout' (${this.options.timeout}ms) is greater than 'checkInterval' (${this.options.checkInterval}ms). Checks might overlap.`);
            }
            // --- End Option Validation ---

            this._state = ConnectionMonitor.States.UNKNOWN;
            this._lastLatency = null;
            this._lastError = null;
            this._consecutiveFailures = 0;
            this._consecutiveSuccesses = 0;
            this._checkTimeoutId = null;
            this._currentAbortController = null;
            this._isStarted = false;
        }

        // --- Getters ---
        get state() { return this._state; }
        get lastLatency() { return this._lastLatency; }
        get lastError() { return this._lastError; }
        get isStarted() { return this._isStarted; }

        /** @private */
        _setState(newState, data = {}) {
            if (!ConnectionMonitor.States[newState]) {
                console.error(`ConnectionMonitor: Attempted to set invalid state: ${newState}`);
                return;
            }
            if (this._state !== newState) {
                const oldState = this._state;
                this._state = newState;

                this.dispatchEvent(new CustomEvent('statechange', {
                    detail: {
                        newState: this._state,
                        oldState: oldState,
                        latency: this._lastLatency,
                        error: this._lastError,
                        timestamp: Date.now(),
                        ...data
                    }
                }));
            }

            // Schedule next check after any state update (or attempted update) if running
            if (this._isStarted) {
                this._scheduleNextCheck();
            }
        }

        /**
         * !! IMPORTANT !!
         * This simulation is used when targetUrl is 'internal-probe'.
         * For real use, remove/comment this out and let _performCheck use actual fetch().
         * @private
         */
        _simulateFetch(options) {
            console.warn("ConnectionMonitor is using SIMULATED fetch.");
            return new Promise((resolve, reject) => {
                const startTime = performance.now();
                let timeoutId;
                const cleanup = () => clearTimeout(timeoutId);

                timeoutId = setTimeout(() => {
                    if (options.signal.aborted) return;
                    const error = new Error('Fetch timed out');
                    error.name = 'AbortError';
                    error.code = 'ETIMEOUT'; // Custom code
                    reject(error);
                }, this.options.timeout);

                options.signal.addEventListener('abort', () => {
                    cleanup();
                    const error = new Error(options.signal.reason || 'Fetch aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });

                const randomFactor = Math.random();
                let delay;
                let simulatedStatus = 200;
                let shouldReject = false;

                if (randomFactor < 0.6) { // Success
                     delay = Math.random() * this.options.latencyThresholdSlow * 1.2;
                } else if (randomFactor < 0.8) { // Slow
                    delay = this.options.latencyThresholdSlow + (Math.random() * (this.options.latencyThresholdDegraded - this.options.latencyThresholdSlow));
                } else if (randomFactor < 0.9) { // Degraded/5xx
                    delay = this.options.latencyThresholdDegraded + (Math.random() * this.options.timeout * 0.5);
                    if (Math.random() < 0.4) { // Higher chance of 5xx when very slow
                        simulatedStatus = 503;
                        shouldReject = true;
                    }
                } else { // Network Error
                    delay = Math.random() * 100;
                    shouldReject = true;
                    simulatedStatus = 0; // Indicate network error simulation
                }

                delay = Math.min(delay, this.options.timeout * 0.98); // Ensure timeout can trigger sometimes

                setTimeout(() => {
                    if (options.signal.aborted) return;
                    cleanup();
                    const endTime = performance.now();
                    const latency = Math.round(endTime - startTime);

                    if (shouldReject) {
                        let error;
                        if (simulatedStatus === 503) {
                            error = new Error(`Simulated HTTP Error: 503 Service Unavailable`);
                            error.status = 503;
                            error.code = 'EHTTP5XX'; // Assign standard code
                        } else {
                            error = new TypeError('Simulated Failed to fetch');
                            error.code = 'ENETWORK'; // Assign standard code
                        }
                        reject(error);
                    } else {
                        resolve({
                            ok: true,
                            status: simulatedStatus,
                            statusText: 'OK (Simulated)',
                            latency: latency // Pass calculated latency
                        });
                    }
                }, delay);
            });
        }


        /** @private */
        async _performCheck() {
            if (this._currentAbortController) {
                // console.debug('Aborting stale check');
                this._currentAbortController.abort('Stale check cancelled');
            }
            this._currentAbortController = new AbortController();
            const { signal } = this._currentAbortController;
            let manualTimeoutId;
            const currentController = this._currentAbortController; // Capture for closure context

            if (this.options.checkNavigatorOnLine && typeof navigator !== 'undefined' && !navigator.onLine) {
                // console.debug('navigator.onLine is false, skipping fetch.');
                this._lastError = new Error("Browser reports navigator.onLine as false.");
                this._lastError.code = 'ENETWORK_NAVIGATOR';
                this._handleFailure(this._lastError);
                return;
            }

            const startTime = performance.now();
            this._lastLatency = null;
            this._lastError = null;
            let responseStatus = null;

            try {
                 // Setup manual timeout as a fallback (though signal.timeout should ideally work)
                manualTimeoutId = setTimeout(() => {
                    if (currentController && !currentController.signal.aborted) {
                         currentController.abort('Fetch timed out');
                    }
                }, this.options.timeout);

                 // Use simulation or actual fetch
                 let response;
                 if (this.targetUrl === 'internal-probe' && typeof this._simulateFetch === 'function') {
                     response = await this._simulateFetch({ signal });
                 } else {
                     // console.debug(`Performing real check: ${this.options.httpMethod} ${this.targetUrl}`);
                     response = await fetch(this.targetUrl, {
                         method: this.options.httpMethod,
                         headers: {
                             ...this.options.headers, // Include custom headers
                             'Cache-Control': 'no-cache, no-store, must-revalidate',
                             'Pragma': 'no-cache',
                             'Expires': '0'
                         },
                         signal: signal, // Use AbortController signal
                         cache: 'no-store', // Explicitly disable caching
                         // AbortSignal.timeout introduced ~late 2022, provides cleaner timeout:
                         // signal: AbortSignal.timeout(this.options.timeout), // Browser handles timeout + abort
                     });
                 }

                clearTimeout(manualTimeoutId);
                const endTime = performance.now();
                // Prefer latency from simulation if available, otherwise calculate
                this._lastLatency = response.latency !== undefined ? response.latency : Math.round(endTime - startTime);
                responseStatus = response.status;

                if (!response.ok) {
                    const error = new Error(`HTTP Error: ${response.status} ${response.statusText || ''}`);
                    error.status = response.status;
                    throw error;
                }

                // console.debug(`Check successful. Latency: ${this._lastLatency}ms, Status: ${responseStatus}`);
                this._handleSuccess();

            } catch (error) {
                clearTimeout(manualTimeoutId);
                const endTime = performance.now(); // Still measure time on failure

                 // Important: Only proceed if the abort was *not* for the current controller's specific action
                 if (currentController.signal.aborted && currentController.signal.reason !== 'Fetch timed out') {
                     // Check if it's one of *our* intentional abort reasons
                     const intentionalReasons = ['Monitor stopped', 'Forced check initiated', 'Stale check cancelled', 'Restarting monitor'];
                     if (intentionalReasons.includes(currentController.signal.reason)) {
                         console.debug(`ConnectionMonitor: Check aborted intentionally: ${currentController.signal.reason}`);
                         this._lastError = new Error(`Fetch aborted: ${currentController.signal.reason}`);
                         this._lastError.code = 'EABORT_INTENTIONAL';
                         // Ensure controller is nulled ONLY if it's the current one for this aborted check
                         if (this._currentAbortController === currentController) {
                            this._currentAbortController = null;
                         }
                         return; // *** EXIT without calling _handleFailure ***
                     }
                 }

                // --- Error Classification (proceed if not an handled intentional abort) ---
                if (error.name === 'AbortError' || error.code === 'ETIMEOUT') { // Includes manual timeout aborts
                    this._lastLatency = Math.round(endTime - startTime); // Record latency up to timeout point
                    this._lastError = new Error(`Request timed out after approx ${this.options.timeout}ms`);
                    this._lastError.code = 'ETIMEOUT';
                } else if (error instanceof TypeError && (error.message.toLowerCase().includes('failed to fetch') || error.message.toLowerCase().includes('networkerror'))) {
                    this._lastError = new Error(`Network error: ${error.message}`);
                    this._lastError.code = 'ENETWORK';
                     if (typeof window !== 'undefined') this._lastError.message += " (Check CORS, DNS, Network, URL)";
                } else if (error.status) { // HTTP errors thrown from !response.ok
                    this._lastError = error; // Already an error object
                    responseStatus = error.status;
                    this._lastError.code = error.status >= 500 ? 'EHTTP5XX' : (error.status >= 400 ? 'EHTTP4XX' : 'EHTTPOTHER');
                } else { // Unexpected errors
                    this._lastError = error instanceof Error ? error : new Error('Unknown check error');
                    this._lastError.code = 'EUNKNOWN';
                }

                // console.debug(`Check failed. Status: ${responseStatus}, Code: ${this._lastError?.code || 'N/A'}, Message: ${this._lastError?.message}`);
                this._handleFailure(this._lastError);

            } finally {
                 // Clear the controller reference *only* if it matches the controller used for this check
                 // Prevents clearing a controller related to a *newer* check if checks somehow overlap heavily
                if (this._currentAbortController === currentController) {
                    this._currentAbortController = null;
                }
                // Next check scheduled via _handleSuccess or _handleFailure -> _setState -> _scheduleNextCheck
            }
        }

        /** @private */
        _handleSuccess() {
            this._consecutiveFailures = 0;
            this._consecutiveSuccesses++;

            let newState = this._state;
            const targetState = (this._lastLatency !== null && this._lastLatency > this.options.latencyThresholdSlow)
                ? ConnectionMonitor.States.SLOW
                : ConnectionMonitor.States.ONLINE;

            switch(this._state) {
                case ConnectionMonitor.States.OFFLINE:
                case ConnectionMonitor.States.UNKNOWN:
                case ConnectionMonitor.States.CONNECTING:
                case ConnectionMonitor.States.DEGRADED: // Recovering from DEGRADED also requires threshold
                    newState = (this._consecutiveSuccesses >= this.options.consecutiveSuccessesThreshold)
                        ? targetState
                        : ConnectionMonitor.States.CONNECTING;
                    break;
                case ConnectionMonitor.States.ONLINE:
                case ConnectionMonitor.States.SLOW:
                     // Already considered 'online-ish', just adjust between ONLINE/SLOW based on latency
                    newState = targetState;
                    break;
                 // default case not strictly needed due to state validation but good practice
            }

            this._setState(newState, { successes: this._consecutiveSuccesses });
        }

        /** @private */
        _handleFailure(error) {
             // Safety net for unexpected null errors
             if (!error) {
                console.warn("ConnectionMonitor: _handleFailure called with invalid error.");
                error = new Error("Internal failure processing error");
                error.code = "EINTERNAL";
             }
            // Always ensure lastError is the one we process, even if synthesized
            this._lastError = error;

            this._consecutiveSuccesses = 0;
            this._consecutiveFailures++;

            // --- Dispatch General Error Event ---
            this.dispatchEvent(new CustomEvent('error', {
                detail: {
                    error: this._lastError,
                    latency: this._lastLatency,
                    failures: this._consecutiveFailures,
                    timestamp: Date.now()
                }
            }));

            // --- State Transition Logic ---
            const isTimeout = error.code === 'ETIMEOUT';
            const isHttp5xx = error.code === 'EHTTP5XX';
            const isNetworkError = error.code?.startsWith('ENETWORK') || ['EUNKNOWN', 'EHTTPOTHER', 'EABORT_UNKNOWN', 'EINTERNAL'].includes(error.code);
            const isHttp4xx = error.code === 'EHTTP4XX';

            let newState = this._state; // Start with current state

            if (this._state !== ConnectionMonitor.States.OFFLINE) {
                 if (this._consecutiveFailures >= this.options.consecutiveFailuresThreshold) {
                    newState = ConnectionMonitor.States.OFFLINE;
                 } else {
                    // Decide intermediate state before hitting OFFLINE threshold
                    if (isTimeout || isHttp5xx || isHttp4xx || this._state === ConnectionMonitor.States.DEGRADED) {
                         // Timeouts, Server errors, Client errors or staying Degraded suggest potential but unhealthy connection
                        newState = ConnectionMonitor.States.DEGRADED;
                    } else if (isNetworkError) {
                        // Clear network errors suggest connectivity issue - move/stay CONNECTING
                        newState = ConnectionMonitor.States.CONNECTING;
                    }
                    // If already in CONNECTING/DEGRADED, might stay there if new state calculation matches
                 }

                // Update the state. Pass error info only if the state *actually* transitions.
                this._setState(newState, {
                    ...(newState !== this._state && { error: this._lastError }),
                    failures: this._consecutiveFailures
                });

            } else { // --- Already OFFLINE ---
                 this.dispatchEvent(new CustomEvent('checkfailed', {
                    detail: {
                        state: this._state,
                        error: this._lastError,
                        failures: this._consecutiveFailures,
                        timestamp: Date.now()
                    }
                 }));
                 // State remains OFFLINE, manually schedule next check as _setState wasn't called for state *change*
                 if (this._isStarted) {
                     this._scheduleNextCheck();
                 }
            }
        }

        /** @private */
        _scheduleNextCheck() {
            if (this._checkTimeoutId) clearTimeout(this._checkTimeoutId);
            this._checkTimeoutId = null;
            if (!this._isStarted) return;

            let baseInterval;
            if (this._state === ConnectionMonitor.States.OFFLINE) {
                // Exponential backoff with cap
                baseInterval = this.options.offlineCheckInterval;
                const failuresWhileOffline = Math.max(0, this._consecutiveFailures - this.options.consecutiveFailuresThreshold);
                const exponent = Math.min(failuresWhileOffline, this.options.backoffExponentCap);
                const backedOffInterval = baseInterval * Math.pow(2, exponent);
                baseInterval = Math.min(backedOffInterval, this.options.maxOfflineCheckInterval);
            } else {
                baseInterval = this.options.checkInterval; // Regular interval for non-offline states
            }

            // Apply jitter: +/- 10% of the base interval
            const jitter = baseInterval * 0.2 * (Math.random() - 0.5);
            let finalInterval = Math.max(100, Math.round(baseInterval + jitter)); // Ensure min interval

            // console.debug(`Scheduling check: ${finalInterval}ms (Base: ${Math.round(baseInterval)}ms, State: ${this._state}, Failures: ${this._consecutiveFailures})`);

            this._checkTimeoutId = setTimeout(() => {
                if (this._isStarted) this._performCheck(); // Check if still started
            }, finalInterval);
        }

        // --- Public Methods ---
        start() {
            if (this._isStarted) return;
            console.log("ConnectionMonitor: Starting...");
            this._isStarted = true;
            this._consecutiveFailures = 0;
            this._consecutiveSuccesses = 0;
            this._lastError = null;
            this._lastLatency = null;

            if (this._checkTimeoutId) clearTimeout(this._checkTimeoutId);
            if (this._currentAbortController) this._currentAbortController.abort('Restarting monitor');
            this._checkTimeoutId = null;
            this._currentAbortController = null;

            // Set initial state (which schedules the *subsequent* checks via _setState)
            this._setState(ConnectionMonitor.States.CONNECTING);

            // Schedule the *first* check immediately after current call stack clears
            this._checkTimeoutId = setTimeout(() => {
                if (this._isStarted) this._performCheck();
            }, 0);
        }

        stop() {
            if (!this._isStarted) return;
            console.log("ConnectionMonitor: Stopping...");
            this._isStarted = false;

            if (this._checkTimeoutId) clearTimeout(this._checkTimeoutId);
            this._checkTimeoutId = null;
            if (this._currentAbortController) {
                this._currentAbortController.abort('Monitor stopped');
                this._currentAbortController = null;
            }

            // Reset state when explicitly stopped
            this._setState(ConnectionMonitor.States.UNKNOWN);
        }

        forceCheck() {
            if (!this._isStarted) {
                console.warn("ConnectionMonitor: Cannot force check - Monitor not started.");
                return;
            }
            console.log("ConnectionMonitor: Forcing immediate check...");
            if (this._checkTimeoutId) clearTimeout(this._checkTimeoutId);
            this._checkTimeoutId = null;
            if (this._currentAbortController) {
                this._currentAbortController.abort('Forced check initiated');
                // _performCheck will handle the stale controller state
            }
            // Schedule forced check ASAP
            this._checkTimeoutId = setTimeout(() => {
                if (this._isStarted) this._performCheck();
            }, 0);
        }
    }
    // --- END ConnectionMonitor Class ---


    // --- Application Logic ---

    // --- Constants and Configuration ---
    const REFRESH_INTERVAL_MS = 10 * 1000;     // Interval for general data refresh (e.g., 10 seconds)
    const POPUP_HIDE_TIMEOUT_MS = 5 * 1000;    // How long popups stay visible (e.g., 5 seconds)
    const PERSISTENT_STORAGE_KEY = 'appPersistentFormValues'; // localStorage key for form data
    const THEME_STORAGE_KEY = 'app-theme';                  // localStorage key for theme preference

    // --- DOM Element Selectors (Ensure these exist in your HTML!) ---
    const $body = document.body;
    const $page = document.querySelector('.page'); // Main container for theme class
    const $toggleTheme = document.querySelector('#toggle-theme'); // Theme toggle button
    const $enableRefreshBtn = document.querySelector('#enable-refresh'); // Auto-refresh toggle button
    const $popup = document.querySelector('.popup'); // Popup container element
    const $popupResponse = document.querySelector('#response'); // Element inside popup to show messages
    const $connectionStatus = document.querySelector('#connection-status'); // To display ConnectionMonitor state
    const $genericDataDisplay = document.querySelector('#data-display'); // Area to show refreshed app data
    const $persistentInputs = document.querySelectorAll('[data-persist]'); // Select inputs marked for persistence

    // --- State Variables ---
    let dataRefreshIntervalId = null;   // Holds the ID from setInterval for data refresh
    let popupHideTimeoutId = null;    // Holds the ID from setTimeout for hiding the popup
    let isAutoRefreshing = false;       // Tracks if auto-refresh is currently enabled

    // --- Connection Monitor Instance & Setup ---
    const connectionMonitor = new ConnectionMonitor('internal-probe', { // Using simulation target by default
        checkInterval: 6000,            // Check every 6 seconds when potentially online
        offlineCheckInterval: 9000,     // Start checking every 9 seconds when offline (with backoff)
        maxOfflineCheckInterval: 45000, // Max offline check interval ~45 seconds
        backoffExponentCap: 4,          // Max backoff multiplier 2^4 = 16
        timeout: 4500,                  // Wait 4.5 seconds for check response
        latencyThresholdSlow: 1000,     // Over 1000ms latency is 'SLOW'
        latencyThresholdDegraded: 2500, // Over 2500ms helps determine 'DEGRADED'
        consecutiveFailuresThreshold: 3,// 3 failures -> OFFLINE
        consecutiveSuccessesThreshold: 2,// 2 successes -> ONLINE/SLOW from OFFLINE/CONNECTING
        httpMethod: 'HEAD',             // Use lightweight HEAD requests (if server supports it)
        checkNavigatorOnLine: true,     // Leverage browser's basic online status check
    });

    connectionMonitor.addEventListener('statechange', (event) => {
        const { newState, oldState, latency, error } = event.detail;
        console.info(`%cCONN_STATE: ${oldState} -> ${newState}`, 'font-weight: bold; color: #007bff;', { latency: latency ?? 'N/A', error: error?.message });

        // Update dedicated UI Indicator
        if ($connectionStatus) {
             $connectionStatus.textContent = newState;
             $connectionStatus.className = 'connection-status'; // Reset classes
             const stateClass = `connection-status--${newState.toLowerCase()}`;
             $connectionStatus.classList.add(stateClass);
             let titleText = `State: ${newState}\nTimestamp: ${new Date().toLocaleTimeString()}`;
             if (latency !== null) titleText += `\nLast Latency: ${latency} ms`;
             if (error) titleText += `\nLast Error: ${error.message} (${error.code || 'N/A'})`;
             $connectionStatus.title = titleText;
        }

        const isEffectivelyOffline = newState === ConnectionMonitor.States.OFFLINE;
        const canAttemptRefresh = [ConnectionMonitor.States.ONLINE, ConnectionMonitor.States.SLOW].includes(newState);

        // Enable/disable UI elements based on connectivity
        const elementsToDisableOffline = [$enableRefreshBtn, ...document.querySelectorAll('button:not(#toggle-theme), input:not([readonly]), textarea, select')]; // Example: disable most interactive elements except theme toggle
        elementsToDisableOffline.forEach(el => {
            if (el) el.disabled = isEffectivelyOffline;
        });


        // Trigger data refresh immediately when coming back reliably online
        if (canAttemptRefresh && (oldState === ConnectionMonitor.States.OFFLINE || oldState === ConnectionMonitor.States.CONNECTING)) {
             console.log("Connection restored, forcing data refresh.");
             refresh(); // Trigger immediate data refresh
        }

         // Adjust auto-refresh behavior based on connection state
         if (isEffectivelyOffline && isAutoRefreshing) {
            console.warn("Connection OFFLINE, stopping auto-refresh.");
            stopDataRefreshing();
            showPopup("Connection lost. Auto-refresh stopped.", true);
         }
    });

    connectionMonitor.addEventListener('error', (event) => {
        const { error, latency, failures } = event.detail;
        console.warn(`%cCONN_ERROR:`, 'color: #ffc107;', { code: error?.code, msg: error?.message, latency: latency ?? 'N/A', failures, state: connectionMonitor.state });
        // Optional: Show non-critical errors in popup?
        // if(error.code !== 'ETIMEOUT' && error.code !== 'ENETWORK') { // Example: only show specific errors
        //     showPopup(`Connection warning: ${error.message}`, false);
        // }
    });

    connectionMonitor.addEventListener('checkfailed', (event) => {
        const { error, failures } = event.detail;
        // Log repetitive failures while offline (less noisy than full error log)
        console.warn(`%cCONN_OFFLINE_FAIL (x${failures}):`, 'color: #dc3545;', { code: error?.code, msg: error?.message });
    });
    // --- End Connection Monitor Setup ---


    // --- Core Application Functions ---

    /** Enables periodic data refreshing */
    function startDataRefreshing() {
        if (dataRefreshIntervalId !== null) return; // Already running

        const currentState = connectionMonitor.state;
        if (currentState === ConnectionMonitor.States.OFFLINE || currentState === ConnectionMonitor.States.UNKNOWN) {
            console.warn("Cannot start auto-refresh: Connection unavailable.");
            showPopup(`Cannot start auto-refresh while ${currentState}.`, true);
            return;
        }

        console.log(`Starting data auto-refresh every ${REFRESH_INTERVAL_MS / 1000} seconds.`);
        isAutoRefreshing = true;
        if ($enableRefreshBtn) {
            $enableRefreshBtn.textContent = 'Disable Auto-Refresh';
            $enableRefreshBtn.setAttribute('aria-pressed', 'true');
        }
        refresh(); // Perform initial refresh immediately
        dataRefreshIntervalId = setInterval(refresh, REFRESH_INTERVAL_MS);
    }

    /** Disables periodic data refreshing */
    function stopDataRefreshing() {
        if (dataRefreshIntervalId === null) return; // Already stopped

        console.log("Stopping data auto-refresh.");
        isAutoRefreshing = false;
        clearInterval(dataRefreshIntervalId);
        dataRefreshIntervalId = null;
        if ($enableRefreshBtn) {
            $enableRefreshBtn.textContent = 'Enable Auto-Refresh';
            $enableRefreshBtn.setAttribute('aria-pressed', 'false');
        }
    }

    /** Simulates fetching application data and updating the UI */
    async function refresh() {
        console.log("Attempting data refresh...");

        // Check connection state before attempting fetch
        const currentState = connectionMonitor.state;
        if (currentState === ConnectionMonitor.States.OFFLINE || currentState === ConnectionMonitor.States.UNKNOWN || currentState === ConnectionMonitor.States.CONNECTING) {
            console.warn(`Skipping data refresh: Connection state is ${currentState}.`);
            if ($genericDataDisplay) {
                $genericDataDisplay.innerHTML = `<p style="color: var(--color-text-muted);">Connection unavailable (${currentState}) - Data refresh skipped</p>`;
            }
            // If auto-refresh is somehow active in these states, stop it.
            if(isAutoRefreshing) stopDataRefreshing();
            return;
        }

        let statusMessage = `<p style="font-style: italic; color: var(--color-text-muted);">Refreshing data (${currentState})...</p>`;
        if (currentState === ConnectionMonitor.States.DEGRADED) {
            console.warn("Connection is DEGRADED, data refresh might be slow or fail.");
             statusMessage += `<p style="color: var(--color-warning);">Connection degraded, expect delays.</p>`;
        }
         if ($genericDataDisplay) $genericDataDisplay.innerHTML = statusMessage; // Show loading/status message


        // --- Simulate Fetching Generic Data ---
        // Replace this block with your actual fetch/AJAX call to a backend API
        try {
            console.log("Simulating fetch for application data...");
            // Simulate network delay (adjust as needed)
            const delay = 500 + Math.random() * (currentState === ConnectionMonitor.States.SLOW ? 1500 : 800);
            await new Promise(resolve => setTimeout(resolve, delay));

             // Simulate occasional refresh errors even if connection seems okay
             if (Math.random() < 0.05) { // 5% chance of simulated API error
                 throw new Error("Simulated API Error: Failed to process request on server.");
             }

            // --- Update Generic Data Display Area on Success ---
            const timestamp = new Date().toLocaleTimeString();
            if ($genericDataDisplay) {
                $genericDataDisplay.innerHTML = `
                    <h4>Dashboard Data</h4>
                    <p>Refreshed at: <strong>${timestamp}</strong></p>
                    <p>Server Status: <span style="color: var(--color-success);">OK</span></p>
                    <p>Connection State: ${connectionMonitor.state} (Latency: ${connectionMonitor.lastLatency ?? 'N/A'} ms)</p>
                    <p>Random Value: ${Math.round(Math.random() * 1000)}</p>
                `;
            }
            console.log("Data refresh simulation successful.");

        } catch (error) {
            console.error("Error during data refresh simulation:", error);
            const timestamp = new Date().toLocaleTimeString();
            showPopup(`Error refreshing data: ${error.message}`, true);
            // Update data display area to show error state
            if ($genericDataDisplay) {
                 $genericDataDisplay.innerHTML = `
                    <h4>Dashboard Data</h4>
                    <p style="color: var(--color-error);">Error loading data at ${timestamp}.</p>
                    <p>Details: ${error.message}</p>
                 `;
            }
        }
    }

    /** Shows a dismissable popup message */
    function showPopup(message, isError = false) {
        if (!$popup || !$popupResponse) {
             console.warn("Popup elements not found in DOM. Message:", message);
             // Fallback to alert if UI elements are missing
             alert(`${isError ? 'ERROR: ' : ''}${message}`);
             return;
        }

        $popupResponse.textContent = message;
        $popup.classList.remove('popup_error', 'popup_success'); // Clear previous status classes
        $popup.classList.add(isError ? 'popup_error' : 'popup_success'); // Use distinct classes
        $popup.classList.add('popup_visible'); // Class to make it visible (using CSS)

        // Clear existing hide timeout if a popup is already shown
        if (popupHideTimeoutId) clearTimeout(popupHideTimeoutId);

        // Automatically hide the popup after a delay
        popupHideTimeoutId = setTimeout(() => {
            $popup.classList.remove('popup_visible');
             popupHideTimeoutId = null;
             // Optional: Reset text after hiding animation might finish
             // setTimeout(() => { if ($popupResponse && !$popup.classList.contains('popup_visible')) $popupResponse.textContent = ''; }, 500);
        }, POPUP_HIDE_TIMEOUT_MS);
    }

    // --- Utility Functions ---

    /** Persists value of an input field to localStorage */
    const storePersistantValue = (fieldId, value) => {
        if (!fieldId) return;
         let storage = {};
         try {
            const stored = localStorage.getItem(PERSISTENT_STORAGE_KEY);
            if (stored) {
                storage = JSON.parse(stored) || {}; // Ensure valid object
            }
         } catch (e) {
            console.error("Failed to read persistent storage:", e);
            storage = {}; // Reset if parsing fails
         }
         storage[fieldId] = value;
         try {
            localStorage.setItem(PERSISTENT_STORAGE_KEY, JSON.stringify(storage));
         } catch (e) {
            console.error(`Failed to write persistent storage for key ${fieldId}:`, e);
            // Maybe show a non-blocking warning to the user?
         }
    };

    /** Restores persisted values from localStorage to corresponding form fields */
    const restorePersistantValues = () => {
        try {
            const stored = localStorage.getItem(PERSISTENT_STORAGE_KEY);
            if (!stored) return;

            const storage = JSON.parse(stored);
            if (typeof storage !== 'object' || storage === null) return; // Ensure it's a usable object

            Object.entries(storage).forEach(([id, value]) => {
                // Find elements by ID or by matching `data-persist` attribute value
                const field = document.getElementById(id) || document.querySelector(`[data-persist="${id}"]`);
                if (!field) {
                    console.warn(`Persistent field with ID/data-persist "${id}" not found.`);
                    return;
                }

                // Restore based on field type
                if ((field.type === 'text' || field.type === 'password' || field.type === 'textarea' || field.type === 'email' || field.type === 'url' || field.type === 'search') && typeof value === 'string') {
                     // Only restore if field is currently empty to avoid overwriting user input from browser cache/autocomplete
                    // if (field.value === '') {
                         field.value = value;
                    // }
                } else if (field.type === 'checkbox' && typeof value === 'boolean') {
                    field.checked = value;
                } else if (field.type === 'radio' && field.value === value) { // For radio groups, find the one with the matching value
                    field.checked = true;
                } else if (field.tagName === 'SELECT' && typeof value === 'string') {
                    // Check if option exists before setting
                    if (field.querySelector(`option[value="${value}"]`)) {
                        field.value = value;
                    }
                }
                 // Add more types as needed (e.g., number, date)
            });
             console.log("Restored persistent form values.");

        } catch (e) {
            console.error("Failed to restore persistent values:", e);
             // Clear potentially corrupted storage?
             // localStorage.removeItem(PERSISTENT_STORAGE_KEY);
        }
    };

    /** Saves the current theme preference to localStorage */
    const storeThemeValue = () => {
         if (!$page) return;
         try {
             // Assuming dark theme is default (no 'page_light' class)
             const currentTheme = $page.classList.contains('page_light') ? 'light' : 'dark';
             localStorage.setItem(THEME_STORAGE_KEY, currentTheme);
             // console.debug("Theme saved:", currentTheme);
         } catch (e) {
             console.error("Failed to store theme preference:", e);
         }
    };

    /** Applies the saved theme preference from localStorage on load */
    const restoreThemeValue = () => {
         if (!$page || !$toggleTheme) return;
         try {
             const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
             // Default to dark theme if no preference or invalid value is stored
             const applyLight = savedTheme === 'light';

             $page.classList.toggle('page_light', applyLight); // Add if light, remove if dark
             $toggleTheme.classList.toggle('theme-toggle-btn_light', applyLight); // Update button state indicator
             $toggleTheme.setAttribute('aria-pressed', String(applyLight));
             $toggleTheme.setAttribute('aria-label', applyLight ? 'Switch to dark theme' : 'Switch to light theme');

             console.log("Restored theme:", applyLight ? 'light' : 'dark');
         } catch (e) {
             console.error("Failed to restore theme preference:", e);
         }
    };


    // --- Initialization Function ---
    function initializeApp() {
        console.log("Application Initializing...");

        if (!$page || !$toggleTheme || !$enableRefreshBtn || !$connectionStatus || !$genericDataDisplay) {
            console.error("Essential UI elements not found in the DOM. Parts of the application may not work.");
            // Consider showing a critical error message to the user
            showPopup("Initialization Error: Critical UI elements missing. Please reload.", true);
            return; // Prevent further initialization if essential elements are missing
        }

        // 1. Restore Theme and Persistent Form Values first
        restoreThemeValue();
        restorePersistantValues(); // Now finds inputs via [data-persist]

        // 2. Setup Connection Monitor
        connectionMonitor.start(); // Start monitoring the network connection

        // 3. Setup Auto-Refresh Toggle Button
        if ($enableRefreshBtn) {
             $enableRefreshBtn.textContent = 'Enable Auto-Refresh'; // Initial state
             $enableRefreshBtn.setAttribute('aria-pressed', 'false');
             $enableRefreshBtn.disabled = (connectionMonitor.state === ConnectionMonitor.States.OFFLINE); // Initially disable if offline
             $enableRefreshBtn.addEventListener('click', () => {
                if (isAutoRefreshing) {
                    stopDataRefreshing();
                } else {
                    startDataRefreshing();
                }
            });
            // Decide if you want auto-refresh on by default IF online
            // if (connectionMonitor.state === ConnectionMonitor.States.ONLINE || connectionMonitor.state === ConnectionMonitor.States.SLOW) {
            //    startDataRefreshing();
            // }
        } else {
             console.warn("Auto-refresh button (#enable-refresh) not found.");
        }


        // 4. Setup Theme Toggle Button
        if ($toggleTheme) {
            $toggleTheme.addEventListener('click', () => {
                const isCurrentlyLight = $page.classList.toggle('page_light');
                $toggleTheme.classList.toggle('theme-toggle-btn_light', isCurrentlyLight);
                $toggleTheme.setAttribute('aria-pressed', String(isCurrentlyLight));
                $toggleTheme.setAttribute('aria-label', isCurrentlyLight ? 'Switch to dark theme' : 'Switch to light theme');
                storeThemeValue(); // Save the new preference
            });
        } else {
             console.warn("Theme toggle button (#toggle-theme) not found.");
        }

        // 5. Setup Persistence Listeners for marked input fields
        if ($persistentInputs.length > 0) {
            $persistentInputs.forEach(input => {
                const fieldId = input.id || input.dataset.persist; // Use ID or data-persist attribute value
                if (!fieldId) {
                    console.warn("Input marked for persistence lacks an 'id' or 'data-persist' attribute:", input);
                    return;
                }
                const eventType = (input.type === 'checkbox' || input.type === 'radio' || input.tagName === 'SELECT') ? 'change' : 'input';
                input.addEventListener(eventType, (event) => {
                    const value = (event.target.type === 'checkbox') ? event.target.checked : event.target.value;
                    storePersistantValue(fieldId, value);
                });
            });
             console.log(`Added persistence listeners to ${$persistentInputs.length} fields.`);
        } else {
             console.log("No fields marked with [data-persist] found for value persistence.");
        }


        // Optional: Add a listener for manual refresh trigger (if you have one)
        const $manualRefreshBtn = document.querySelector('#manual-refresh'); // Example ID
        if($manualRefreshBtn) {
             $manualRefreshBtn.addEventListener('click', refresh);
        }

         // Optional: Force connection check button for debugging
         /*
         const forceCheckBtn = document.createElement('button');
         forceCheckBtn.textContent = 'Force Conn Check';
         forceCheckBtn.style.cssText = 'position: fixed; bottom: 10px; right: 10px; z-index: 1001; padding: 5px; background-color: #ffc107; border: none; cursor: pointer;';
         forceCheckBtn.addEventListener('click', () => connectionMonitor.forceCheck());
         document.body.appendChild(forceCheckBtn);
         */

         console.log("Application Initialization complete.");
         showPopup("Application ready.", false); // Indicate successful init
    }

    // --- Run Initialization when DOM is ready ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeApp);
    } else {
        // DOMContentLoaded has already fired
        initializeApp();
    }

    // --- Cleanup on Page Unload ---
    window.addEventListener('beforeunload', () => {
        console.log("Page unloading, stopping monitor and clearing intervals.");
        connectionMonitor.stop(); // Stop connection checks
        stopDataRefreshing();     // Stop any active data refresh interval
        // Any other cleanup needed before the page closes
    });

})(); // End IIFE

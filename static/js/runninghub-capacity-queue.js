(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.RunningHubCapacityQueueTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    function hasExactQueueToken(value){
        return /(^|[^A-Z0-9_])TASK_QUEUE_MAXED($|[^A-Z0-9_])/i.test(String(value || ''));
    }

    function isRunningHubQueueMaxed(value, seen=new Set()){
        if(value === null || value === undefined) return false;
        if(typeof value === 'string' || typeof value === 'number') return hasExactQueueToken(value);
        if(typeof value !== 'object' || seen.has(value)) return false;
        seen.add(value);
        if(hasExactQueueToken(value.message) || hasExactQueueToken(value.code) || hasExactQueueToken(value.errorCode)) return true;
        if(value.payload && isRunningHubQueueMaxed(value.payload, seen)) return true;
        return Object.values(value).some(item => isRunningHubQueueMaxed(item, seen));
    }

    class RunningHubQueueCancelledError extends Error {
        constructor(message='RunningHub queued task cancelled'){
            super(message);
            this.name = 'RunningHubQueueCancelledError';
            this.runningHubQueueCancelled = true;
        }
    }

    class RunningHubCapacityQueue {
        constructor(options={}){
            this.retryDelay = Math.max(100, Number(options.retryDelay) || 12000);
            this.entries = [];
            this.retrying = false;
            this.wakeRequested = false;
            this.timer = null;
            this.setTimeoutFn = options.setTimeoutFn || setTimeout;
            this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
        }

        get size(){ return this.entries.length; }

        position(predicate){
            const index = this.entries.findIndex(predicate);
            return index >= 0 ? index + 1 : 0;
        }

        submit(submitFn, meta={}){
            const entry = {
                ...meta,
                submitFn,
                cancelled:false,
                inFlight:false,
                resolve:null,
                reject:null,
            };
            const promise = new Promise((resolve, reject) => {
                entry.resolve = resolve;
                entry.reject = reject;
            });
            this._notify(entry, 'submitting');
            Promise.resolve().then(() => submitFn()).then(
                result => {
                    if(entry.cancelled) entry.reject(new RunningHubQueueCancelledError());
                    else {
                        this._notify(entry, 'accepted', result);
                        entry.resolve(result);
                    }
                },
                error => {
                    if(entry.cancelled) entry.reject(new RunningHubQueueCancelledError());
                    else if(isRunningHubQueueMaxed(error)) this._enqueue(entry);
                    else entry.reject(error);
                },
            );
            return promise;
        }

        wake(){
            if(this.timer){
                const clearTimeoutFn = this.clearTimeoutFn;
                clearTimeoutFn(this.timer);
                this.timer = null;
            }
            if(this.retrying){
                this.wakeRequested = true;
                return;
            }
            if(!this.entries.length) return;
            this.retrying = true;
            this._retryHead().finally(() => {
                this.retrying = false;
                if(this.wakeRequested){
                    this.wakeRequested = false;
                    this.wake();
                }
            });
        }

        cancel(predicate, message='RunningHub queued task cancelled'){
            let count = 0;
            const keep = [];
            this.entries.forEach(entry => {
                if(!predicate(entry)){
                    keep.push(entry);
                    return;
                }
                count += 1;
                entry.cancelled = true;
                this._notify(entry, 'cancelled');
                if(!entry.inFlight) entry.reject(new RunningHubQueueCancelledError(message));
                else keep.push(entry);
            });
            this.entries = keep;
            if(!this.entries.length && this.timer){
                const clearTimeoutFn = this.clearTimeoutFn;
                clearTimeoutFn(this.timer);
                this.timer = null;
            }
            return count;
        }

        _notify(entry, state, value){
            if(typeof entry.onState === 'function') entry.onState(state, entry, value);
        }

        _enqueue(entry){
            if(entry.cancelled){
                entry.reject(new RunningHubQueueCancelledError());
                return;
            }
            if(!this.entries.includes(entry)) this.entries.push(entry);
            this._notify(entry, 'queued');
            this._schedule();
        }

        _schedule(){
            if(this.timer || !this.entries.length) return;
            const setTimeoutFn = this.setTimeoutFn;
            this.timer = setTimeoutFn(() => {
                this.timer = null;
                this.wake();
            }, this.retryDelay);
            this.timer?.unref?.();
        }

        async _retryHead(){
            const entry = this.entries[0];
            if(!entry) return;
            if(entry.cancelled){
                this.entries.shift();
                entry.reject(new RunningHubQueueCancelledError());
                if(this.entries.length) this._schedule();
                return;
            }
            entry.inFlight = true;
            this._notify(entry, 'submitting');
            try {
                const result = await entry.submitFn();
                if(this.entries[0] === entry) this.entries.shift();
                entry.inFlight = false;
                if(entry.cancelled) entry.reject(new RunningHubQueueCancelledError());
                else {
                    this._notify(entry, 'accepted', result);
                    entry.resolve(result);
                }
            } catch(error){
                entry.inFlight = false;
                if(entry.cancelled){
                    if(this.entries[0] === entry) this.entries.shift();
                    entry.reject(new RunningHubQueueCancelledError());
                } else if(isRunningHubQueueMaxed(error)){
                    this._notify(entry, 'queued');
                } else {
                    if(this.entries[0] === entry) this.entries.shift();
                    entry.reject(error);
                }
            }
            if(this.entries.length) this._schedule();
        }
    }

    class RunningHubTaskRegistry {
        constructor(cancelTask){
            this.tasks = new Map();
            this.cancelPromises = new Map();
            this.cancelTask = cancelTask;
        }

        register(taskId, meta={}){
            const id = String(taskId || '').trim();
            if(!id) return null;
            const task = {taskId:id, ...meta};
            this.tasks.set(id, task);
            return task;
        }

        unregister(taskId){
            return this.tasks.delete(String(taskId || ''));
        }

        list(predicate=()=>true){
            return [...this.tasks.values()].filter(predicate);
        }

        async cancel(predicate=()=>true){
            const tasks = this.list(predicate);
            const settled = await Promise.all(tasks.map(task => {
                const taskId = task.taskId;
                if(this.cancelPromises.has(taskId)) return this.cancelPromises.get(taskId);
                const promise = Promise.resolve().then(() => this.cancelTask(task)).then(
                    value => ({ok:true, value}),
                    error => ({ok:false, error}),
                ).finally(() => {
                    this.unregister(taskId);
                    this.cancelPromises.delete(taskId);
                });
                this.cancelPromises.set(taskId, promise);
                return promise;
            }));
            return {
                attempted:tasks.length,
                failed:settled.filter(item => !item.ok).length,
                results:settled,
            };
        }
    }

    return {RunningHubCapacityQueue, RunningHubQueueCancelledError, RunningHubTaskRegistry, isRunningHubQueueMaxed};
});

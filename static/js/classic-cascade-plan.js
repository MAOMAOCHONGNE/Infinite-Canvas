(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.ClassicCascadePlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    function graphState(nodes, connections){
        const list = (nodes || []).filter(node => node?.id);
        const byId = new Map(list.map(node => [node.id, node]));
        const position = new Map(list.map((node, index) => [node.id, index]));
        const incoming = new Map(list.map(node => [node.id, []]));
        const outgoing = new Map(list.map(node => [node.id, []]));
        (connections || []).forEach(connection => {
            if(!byId.has(connection?.from) || !byId.has(connection?.to)) return;
            outgoing.get(connection.from).push(connection.to);
            incoming.get(connection.to).push(connection.from);
        });
        return {list, byId, position, incoming, outgoing};
    }

    function reverseReachable(state, targetId){
        const found = new Set();
        const pending = [targetId];
        while(pending.length){
            const id = pending.shift();
            if(!id || found.has(id) || !state.byId.has(id)) continue;
            found.add(id);
            (state.incoming.get(id) || []).forEach(from => pending.push(from));
        }
        return found;
    }

    function forwardReachable(state, sourceId, allowed){
        const found = new Set();
        const pending = [sourceId];
        while(pending.length){
            const id = pending.shift();
            if(!id || found.has(id) || !allowed.has(id)) continue;
            found.add(id);
            (state.outgoing.get(id) || []).forEach(to => pending.push(to));
        }
        return found;
    }

    function nearestLoopId(state, targetId, ancestors){
        const seen = new Set([targetId]);
        let level = [targetId];
        while(level.length){
            const next = [];
            for(const id of level){
                for(const from of (state.incoming.get(id) || [])){
                    if(seen.has(from) || !ancestors.has(from)) continue;
                    seen.add(from);
                    if(state.byId.get(from)?.type === 'loop') return from;
                    next.push(from);
                }
            }
            level = next;
        }
        return '';
    }

    function topologicalAncestorOrder(state, ancestors){
        const indegree = new Map();
        ancestors.forEach(id => indegree.set(id, 0));
        ancestors.forEach(id => {
            (state.outgoing.get(id) || []).forEach(to => {
                if(ancestors.has(to)) indegree.set(to, (indegree.get(to) || 0) + 1);
            });
        });
        const byPosition = (a, b) => (state.position.get(a) || 0) - (state.position.get(b) || 0);
        const ready = [...ancestors].filter(id => indegree.get(id) === 0).sort(byPosition);
        const ordered = [];
        while(ready.length){
            const id = ready.shift();
            ordered.push(id);
            (state.outgoing.get(id) || []).forEach(to => {
                if(!ancestors.has(to)) return;
                indegree.set(to, indegree.get(to) - 1);
                if(indegree.get(to) === 0){
                    ready.push(to);
                    ready.sort(byPosition);
                }
            });
        }
        if(ordered.length < ancestors.size){
            [...ancestors]
                .filter(id => !ordered.includes(id))
                .sort(byPosition)
                .forEach(id => ordered.push(id));
        }
        return ordered;
    }

    function buildCascadePlan(nodes, connections, targetId, runTypes, options={}){
        const state = graphState(nodes, connections);
        const runnable = new Set(runTypes || []);
        if(!state.byId.has(targetId)){
            return {targetId, loopId:'', onceOrder:[], loopOrder:[], loopStages:[], allOrder:[]};
        }
        const ancestors = reverseReachable(state, targetId);
        const orderedAncestors = topologicalAncestorOrder(state, ancestors);
        const orderedLoopIds = orderedAncestors.filter(id => state.byId.get(id)?.type === 'loop');
        const stageByLoopId = new Map(orderedLoopIds.map(loopId => [loopId, {loopId, order:[]} ]));
        const requestedLoop = String(options.loopId || '');
        const loopId = requestedLoop && ancestors.has(requestedLoop) && state.byId.get(requestedLoop)?.type === 'loop'
            ? requestedLoop
            : nearestLoopId(state, targetId, ancestors);
        const orderedRunnable = orderedAncestors
            .filter(id => runnable.has(state.byId.get(id)?.type));
        const onceOrder = [];
        orderedRunnable.forEach(id => {
            const nodeAncestors = reverseReachable(state, id);
            const controllingLoopId = nearestLoopId(state, id, nodeAncestors);
            const stage = stageByLoopId.get(controllingLoopId);
            if(stage) stage.order.push(id);
            else onceOrder.push(id);
        });
        const loopStages = orderedLoopIds.map(id => stageByLoopId.get(id)).filter(stage => stage.order.length);
        const loopOrder = loopStages.find(stage => stage.loopId === loopId)?.order || [];
        return {
            targetId,
            loopId,
            onceOrder,
            loopOrder:[...loopOrder],
            loopStages:loopStages.map(stage => ({loopId:stage.loopId, order:[...stage.order]})),
            allOrder:[...onceOrder, ...loopStages.flatMap(stage => stage.order)],
        };
    }

    function buildExecutionStages(plan, options={}){
        const scope = options.scope === 'loop' ? 'loop' : 'complete';
        const configuredStages = Array.isArray(plan?.loopStages) && plan.loopStages.length
            ? plan.loopStages
            : plan?.loopId
                ? [{loopId:plan.loopId, order:[...(plan.loopOrder || [])]}]
                : [];
        const requestedLoopId = String(options.loopId || plan?.loopId || '');
        const selectedStages = scope === 'loop'
            ? configuredStages.filter(stage => stage.loopId === requestedLoopId)
            : configuredStages;
        const loopSettingsById = options.loopSettingsById || {};
        const stages = selectedStages.map(stage => {
            const settings = loopSettingsById[stage.loopId] || {};
            const startRound = Math.max(1, Math.floor(Number(settings.startRound ?? options.startRound) || 1));
            const totalRounds = Math.max(1, Math.floor(Number(settings.totalRounds ?? options.totalRounds) || 1));
            const order = [...(stage.order || [])];
            return {
                loopId:stage.loopId,
                order,
                rounds:Array.from({length:totalRounds}, (_, offset) => ({index:startRound + offset, order:[...order]})),
            };
        });
        const legacyStage = stages.find(stage => stage.loopId === requestedLoopId) || stages[0];
        return {
            onceOrder:scope === 'complete' ? [...(plan?.onceOrder || [])] : [],
            stages,
            rounds:legacyStage ? [...legacyStage.rounds] : [],
        };
    }

    function checkLoopImageAvailability(options={}){
        const enabled = options.enabled === true;
        const available = Math.max(0, Math.floor(Number(options.available) || 0));
        if(!enabled) return {ok:true, available, required:0, firstEmptyRound:0};
        const startRound = Math.max(1, Math.floor(Number(options.startRound) || 1));
        const totalRounds = Math.max(1, Math.floor(Number(options.totalRounds) || 1));
        const batchSize = Math.max(1, Math.floor(Number(options.batchSize) || 1));
        let firstEmptyRound = 0;
        for(let offset = 0; offset < totalRounds; offset++){
            const round = startRound + offset;
            if((round - 1) * batchSize >= available){
                firstEmptyRound = round;
                break;
            }
        }
        const finalRound = startRound + totalRounds - 1;
        const required = (finalRound - 1) * batchSize + 1;
        return {ok:firstEmptyRound === 0, available, required, firstEmptyRound};
    }

    function fitLoopRoundsToAvailableImages(options={}){
        const enabled = options.enabled === true;
        const available = Math.max(0, Math.floor(Number(options.available) || 0));
        const startRound = Math.max(1, Math.floor(Number(options.startRound) || 1));
        const configuredRounds = Math.max(1, Math.floor(Number(options.totalRounds) || 1));
        const batchSize = Math.max(1, Math.floor(Number(options.batchSize) || 1));
        if(!enabled){
            return {
                enabled,
                available,
                startRound,
                configuredRounds,
                runnableRounds:configuredRounds,
                skippedRounds:0,
                batchSize,
                lastBatchSize:0,
            };
        }
        const startOffset = (startRound - 1) * batchSize;
        const remaining = Math.max(0, available - startOffset);
        const runnableRounds = Math.min(configuredRounds, Math.ceil(remaining / batchSize));
        const skippedRounds = configuredRounds - runnableRounds;
        const lastBatchSize = runnableRounds > 0
            ? Math.min(batchSize, Math.max(0, remaining - ((runnableRounds - 1) * batchSize)))
            : 0;
        return {
            enabled,
            available,
            startRound,
            configuredRounds,
            runnableRounds,
            skippedRounds,
            batchSize,
            lastBatchSize,
        };
    }

    function fitLoopRoundsToAvailablePrompts(options={}){
        const enabled = options.enabled === true;
        const available = Math.max(0, Math.floor(Number(options.available) || 0));
        const startRound = Math.max(1, Math.floor(Number(options.startRound) || 1));
        const configuredRounds = Math.max(1, Math.floor(Number(options.totalRounds) || 1));
        if(!enabled){
            return {
                enabled,
                available,
                startRound,
                configuredRounds,
                runnableRounds:configuredRounds,
                skippedRounds:0,
            };
        }
        const remaining = Math.max(0, available - (startRound - 1));
        const runnableRounds = Math.min(configuredRounds, remaining);
        return {
            enabled,
            available,
            startRound,
            configuredRounds,
            runnableRounds,
            skippedRounds:configuredRounds - runnableRounds,
        };
    }

    async function runTolerantLoopRounds(rounds, limit, runner, isAbort=()=>false){
        const list = Array.isArray(rounds) ? [...rounds] : [];
        if(!list.length) return {attemptedRounds:0, successfulRounds:0, failedRounds:0, failures:[], outcomes:[]};
        const outcomes = new Array(list.length);
        let next = 0;
        let abortError = null;
        const workerCount = Math.max(1, Math.min(Math.floor(Number(limit) || 1), list.length));
        const workers = Array.from({length:workerCount}, async () => {
            while(next < list.length && !abortError){
                const position = next++;
                const round = list[position];
                try {
                    const value = await runner(round, position);
                    outcomes[position] = {status:'fulfilled', round, value};
                } catch(error){
                    if(isAbort(error)){
                        abortError = error;
                        throw error;
                    }
                    outcomes[position] = {status:'rejected', round, reason:error};
                }
            }
        });
        const workersSettled = await Promise.allSettled(workers);
        if(abortError) throw abortError;
        const unexpected = workersSettled.find(result => result.status === 'rejected');
        if(unexpected) throw unexpected.reason;
        const failures = outcomes.filter(outcome => outcome?.status === 'rejected');
        return {
            attemptedRounds:outcomes.filter(Boolean).length,
            successfulRounds:outcomes.filter(outcome => outcome?.status === 'fulfilled').length,
            failedRounds:failures.length,
            failures,
            outcomes,
        };
    }

    function runActionTooltip(action){
        if(action === 'api') return '只运行当前 API 节点一次。';
        if(action === 'loop') return '使用已有结果，只处理循环步骤，不重新运行前面的内容。';
        return '';
    }

    function buildCurrentNodePreview(targetId){
        return {
            currentRunnableNodeIds:targetId ? [targetId] : [],
            onceRunnableNodeIds:[],
            loopRunnableNodeIds:[],
            onceDataNodeIds:[],
            loopDataNodeIds:[],
            onceEdgeIds:[],
            loopEdgeIds:[],
        };
    }

    function growLoopNodeHeight(options={}){
        const currentHeight = Math.max(0, Math.ceil(Number(options.currentHeight) || 0));
        const bodyScrollHeight = Math.max(0, Math.ceil(Number(options.bodyScrollHeight) || 0));
        const headerHeight = Math.max(0, Math.ceil(Number(options.headerHeight) || 0));
        const maxHeight = Math.max(1, Math.ceil(Number(options.maxHeight) || 900));
        const requiredHeight = Math.min(maxHeight, bodyScrollHeight + headerHeight + 2);
        return Math.max(currentHeight, requiredHeight);
    }

    function inputQuickCreateTypes(nodeType){
        return nodeType === 'loop' ? ['image', 'prompt', 'group', 'llm'] : [];
    }

    function composeGeneratorPrompt(upstreamPrompts, localPrompt){
        const parts = (Array.isArray(upstreamPrompts) ? upstreamPrompts : [upstreamPrompts])
            .map(value => String(value ?? ''))
            .filter(value => value.trim());
        const local = String(localPrompt ?? '');
        if(local.trim()) parts.push(local);
        return parts.join('\n\n');
    }

    function removeConnectionsAndReconcileLoops(nodes, connections, shouldRemove){
        const list = Array.isArray(nodes) ? nodes : [];
        const byId = new Map(list.filter(node => node?.id).map(node => [node.id, node]));
        const remove = typeof shouldRemove === 'function' ? shouldRemove : () => false;
        const removed = [];
        const kept = [];
        (connections || []).forEach(connection => {
            if(remove(connection)) removed.push(connection);
            else kept.push(connection);
        });
        const affectedLoopIds = [];
        removed.forEach(connection => {
            const loop = byId.get(connection?.to);
            if(loop?.type === 'loop' && !affectedLoopIds.includes(loop.id)) affectedLoopIds.push(loop.id);
        });
        const imageSourceTypes = new Set(['image', 'group', 'output']);
        const changedLoopIds = [];
        affectedLoopIds.forEach(loopId => {
            const loop = byId.get(loopId);
            if(loop?.imageInput !== true) return;
            const hasImageInput = kept.some(connection =>
                connection?.to === loopId && imageSourceTypes.has(byId.get(connection?.from)?.type)
            );
            if(hasImageInput) return;
            loop.imageInput = false;
            changedLoopIds.push(loopId);
        });
        return {connections:kept, removed, changedLoopIds};
    }

    function buildCascadePreview(nodes, connections, targetId, runTypes, options={}){
        const empty = {
            onceRunnableNodeIds:[],
            loopRunnableNodeIds:[],
            onceDataNodeIds:[],
            loopDataNodeIds:[],
            onceEdgeIds:[],
            loopEdgeIds:[],
        };
        const state = graphState(nodes, connections);
        if(!state.byId.has(targetId)) return empty;
        const scope = options.scope === 'loop' ? 'loop' : 'complete';
        const plan = buildCascadePlan(nodes, connections, targetId, runTypes, options);
        const ancestors = reverseReachable(state, targetId);
        const selectedStages = scope === 'loop'
            ? (plan.loopStages || []).filter(stage => stage.loopId === plan.loopId)
            : (plan.loopStages || []);
        const onceRunnableNodeIds = scope === 'complete' ? [...plan.onceOrder] : [];
        const loopRunnableNodeIds = selectedStages.flatMap(stage => stage.order);
        const onceRunnable = new Set(onceRunnableNodeIds);
        const loopRunnable = new Set(loopRunnableNodeIds);
        const selectedLoopIds = new Set(selectedStages.map(stage => stage.loopId));
        const onceEdgeIds = [];
        const loopEdgeIds = [];
        const pushEdge = (stage, connection) => {
            if(!connection?.id) return;
            const target = stage === 'loop' ? loopEdgeIds : onceEdgeIds;
            if(!target.includes(connection.id)) target.push(connection.id);
        };

        (connections || []).forEach(connection => {
            const fromInAncestors = ancestors.has(connection?.from);
            const toInAncestors = ancestors.has(connection?.to);
            const targetIsOutput = state.byId.get(connection?.to)?.type === 'output';
            if(!fromInAncestors || (!toInAncestors && !targetIsOutput)) return;
            if(
                selectedLoopIds.has(connection.to)
                || loopRunnable.has(connection.to)
                || (loopRunnable.has(connection.from) && targetIsOutput)
            ){
                pushEdge('loop', connection);
                return;
            }
            if(scope === 'complete' && (
                onceRunnable.has(connection.to)
                || (onceRunnable.has(connection.from) && targetIsOutput)
            )) pushEdge('once', connection);
        });

        const edgeById = new Map((connections || []).filter(edge => edge?.id).map(edge => [edge.id, edge]));
        const runnable = new Set([...onceRunnableNodeIds, ...loopRunnableNodeIds]);
        const dataNodesFor = edgeIds => {
            const ids = [];
            edgeIds.forEach(edgeId => {
                const edge = edgeById.get(edgeId);
                [edge?.from, edge?.to].forEach(id => {
                    if(id && !runnable.has(id) && !ids.includes(id)) ids.push(id);
                });
            });
            return ids;
        };
        return {
            onceRunnableNodeIds,
            loopRunnableNodeIds,
            onceDataNodeIds:dataNodesFor(onceEdgeIds),
            loopDataNodeIds:dataNodesFor(loopEdgeIds),
            onceEdgeIds,
            loopEdgeIds,
        };
    }

    return {
        buildCascadePlan,
        buildExecutionStages,
        checkLoopImageAvailability,
        fitLoopRoundsToAvailableImages,
        fitLoopRoundsToAvailablePrompts,
        runTolerantLoopRounds,
        runActionTooltip,
        buildCurrentNodePreview,
        growLoopNodeHeight,
        inputQuickCreateTypes,
        composeGeneratorPrompt,
        removeConnectionsAndReconcileLoops,
        buildCascadePreview,
    };
});

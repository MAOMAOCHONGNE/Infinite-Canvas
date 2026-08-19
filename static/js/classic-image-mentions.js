(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.ClassicImageMentions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict';

    const DEFAULT_MAX_REFS = 20;

    function cleanName(value, fallback='图片'){
        const text = String(value || '').replace(/^@+/, '').replace(/@/g, '＠').replace(/\s+/g, ' ').trim();
        return (text || fallback).slice(0, 40);
    }

    function refKey(ref){
        if(!ref || !ref.url) return '';
        const nodeId = String(ref.nodeId || '').trim();
        const imageIndex = Number.isFinite(Number(ref.imageIndex)) ? String(Number(ref.imageIndex)) : '';
        return nodeId && imageIndex !== '' ? `${nodeId}|${imageIndex}` : `url|${ref.url}`;
    }

    function normalizeRef(ref, index=0){
        if(!ref || !String(ref.url || '').trim()) return null;
        const name = cleanName(ref.name || ref.alias, `图片${index + 1}`);
        return {
            ...ref,
            url:String(ref.url).trim(),
            name,
            marker:cleanName(ref.marker || ref.mentionName || name, name),
            kind:String(ref.kind || 'image').toLowerCase(),
        };
    }

    function normalizeMentions(records){
        const seen = new Set();
        return (Array.isArray(records) ? records : []).map((record, index) => {
            const ref = normalizeRef(record, index);
            if(!ref) return null;
            const key = String(record.id || record.mentionId || refKey(ref) || `mention-${index}`);
            if(seen.has(key)) return null;
            seen.add(key);
            return {...ref, id:key};
        }).filter(Boolean);
    }

    function uniqueRefs(records, max=DEFAULT_MAX_REFS){
        const refs = [];
        const seenUrls = new Set();
        (Array.isArray(records) ? records : []).forEach((record, index) => {
            const ref = normalizeRef(record, index);
            if(!ref || seenUrls.has(ref.url) || refs.length >= max) return;
            seenUrls.add(ref.url);
            refs.push(ref);
        });
        return refs;
    }

    function activeMentions(text, records){
        const value = String(text || '');
        return normalizeMentions(records).filter(record => mentionPattern(record.marker || record.name).test(value));
    }

    function mentionPattern(name){
        const escaped = cleanName(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`@${escaped}(?![\\p{L}\\p{N}_（(])`, 'gu');
    }

    function buildPromptRequest(options={}){
        const sourceText = String(options.text || '').trim();
        const max = Math.max(1, Number(options.maxRefs || DEFAULT_MAX_REFS) || DEFAULT_MAX_REFS);
        const refs = uniqueRefs(options.defaultRefs, max);
        const mentions = activeMentions(sourceText, options.mentions);
        mentions.forEach(mention => {
            if(refs.length >= max || refs.some(ref => ref.url === mention.url)) return;
            refs.push(normalizeRef(mention, refs.length));
        });

        let body = sourceText;
        let mentioned = false;
        [...mentions].sort((a, b) => b.name.length - a.name.length).forEach(mention => {
            const index = refs.findIndex(ref => ref.url === mention.url);
            if(index < 0) return;
            const pattern = mentionPattern(mention.marker || mention.name);
            if(!pattern.test(body)) return;
            pattern.lastIndex = 0;
            body = body.replace(pattern, `图${index + 1}`);
            mentioned = true;
        });

        if(!mentioned) return {prompt:sourceText, displayPrompt:sourceText, refs, mentioned:false};
        const mapHeader = String(options.mapHeader || '下面是参考图编号：');
        const userHeader = String(options.userHeader || '用户需求：');
        const map = refs.map((ref, index) => `图${index + 1}：${ref.name || `图片${index + 1}`}`).join('\n');
        return {
            prompt:`${mapHeader}\n${map}\n\n${userHeader}\n${body}`,
            displayPrompt:sourceText,
            refs,
            mentioned:true,
        };
    }

    function mapTextWithRefs(text, records, refs){
        let body = String(text || '').trim();
        let mentioned = false;
        [...activeMentions(body, records)].sort((a, b) => b.name.length - a.name.length).forEach(mention => {
            const index = refs.findIndex(ref => ref.url === mention.url);
            if(index < 0) return;
            const pattern = mentionPattern(mention.marker || mention.name);
            if(!pattern.test(body)) return;
            pattern.lastIndex = 0;
            body = body.replace(pattern, `图${index + 1}`);
            mentioned = true;
        });
        return {text:body, mentioned};
    }

    function buildCompositePromptRequest(options={}){
        const max = Math.max(1, Number(options.maxRefs || DEFAULT_MAX_REFS) || DEFAULT_MAX_REFS);
        const parts = (Array.isArray(options.parts) ? options.parts : [])
            .map(part => ({text:String(part?.text || ''), mentions:part?.mentions}))
            .filter(part => part.text.trim());
        const refs = uniqueRefs(options.defaultRefs, max);
        parts.forEach(part => {
            activeMentions(part.text, part.mentions).forEach(mention => {
                if(refs.length >= max || refs.some(ref => ref.url === mention.url)) return;
                refs.push(normalizeRef(mention, refs.length));
            });
        });
        const mapped = parts.map(part => mapTextWithRefs(part.text, part.mentions, refs));
        const separator = String(options.separator ?? '\n\n');
        const body = mapped.map(part => part.text).filter(Boolean).join(separator);
        const displayPrompt = parts.map(part => part.text.trim()).filter(Boolean).join(separator);
        const mentioned = mapped.some(part => part.mentioned);
        if(!mentioned) return {prompt:body, displayPrompt, refs, mentioned:false};
        const mapHeader = String(options.mapHeader || '下面是参考图编号：');
        const userHeader = String(options.userHeader || '用户需求：');
        const map = refs.map((ref, index) => `图${index + 1}：${ref.name || `图片${index + 1}`}`).join('\n');
        return {
            prompt:`${mapHeader}\n${map}\n\n${userHeader}\n${body}`,
            displayPrompt,
            refs,
            mentioned:true,
        };
    }

    function buildChatMessage(options={}){
        const content = String(options.content || '').trim();
        const requestContent = String(options.requestContent || '').trim();
        const images = uniqueRefs(options.refs, DEFAULT_MAX_REFS).map(ref => ({
            url:ref.url,
            name:ref.name,
            kind:ref.kind || 'image',
            ...(ref.thumbnail ? {thumbnail:ref.thumbnail} : {}),
        }));
        const message = {role:'user', content};
        if(requestContent && requestContent !== content) message.requestContent = requestContent;
        if(images.length) message.images = images;
        return message;
    }

    function nextUniqueName(ref, records){
        const normalized = normalizeRef(ref) || {name:'图片', url:''};
        const existing = normalizeMentions(records);
        const sameRef = existing.find(item => item.url === normalized.url);
        if(sameRef) return sameRef.name;
        const used = new Set(existing.map(item => item.name));
        if(!used.has(normalized.name)) return normalized.name;
        let number = 2;
        while(used.has(`${normalized.name}（${number}）`)) number += 1;
        return `${normalized.name}（${number}）`;
    }

    function nextUniqueMarker(ref, records){
        const normalized = normalizeRef(ref) || {name:'图片', marker:'图片', url:''};
        const existing = normalizeMentions(records);
        const sameRef = existing.find(item => item.url === normalized.url);
        const base = cleanName(ref?.marker || ref?.mentionName || normalized.name, normalized.name);
        if(sameRef && (sameRef.marker || sameRef.name) === base) return base;
        const used = new Set(existing.filter(item => item.url !== normalized.url).map(item => item.marker || item.name));
        if(!used.has(base)) return base;
        let number = 2;
        while(used.has(`${base}（${number}）`)) number += 1;
        return `${base}（${number}）`;
    }

    function insertMention(options={}){
        let value = String(options.text || '');
        let start = Math.max(0, Math.min(value.length, Number(options.selectionStart ?? value.length)));
        let end = Math.max(start, Math.min(value.length, Number(options.selectionEnd ?? start)));
        let records = normalizeMentions(options.mentions);
        const hasExplicitMarker = Boolean(String(options.ref?.marker || options.ref?.mentionName || '').trim());
        const ref = normalizeRef(options.ref, records.length);
        if(!ref) return {text:value, caret:start, mentions:records};
        const marker = hasExplicitMarker ? nextUniqueMarker(ref, records) : nextUniqueName(ref, records);
        const name = hasExplicitMarker ? ref.name : marker;
        let existing = records.find(item => item.url === ref.url);
        if(existing && hasExplicitMarker && (existing.marker || existing.name) !== marker){
            const oldMarker = existing.marker || existing.name;
            const replaceMarker = source => String(source || '').replace(mentionPattern(oldMarker), `@${marker}`);
            start = replaceMarker(value.slice(0, start)).length;
            end = replaceMarker(value.slice(0, end)).length;
            value = replaceMarker(value);
            records = records.map(item => item.url === ref.url ? {...item, name:item.name || ref.name, marker} : item);
            existing = records.find(item => item.url === ref.url);
        }
        const mention = existing || {
            ...ref,
            id:String(ref.id || ref.mentionId || `mention-${Date.now()}-${records.length}`),
            name,
            marker,
        };
        const replaceStart = start > 0 && value[start - 1] === '@' ? start - 1 : start;
        const needsTrailingSpace = end >= value.length || !/^\s/.test(value.slice(end));
        const insertion = `@${mention.marker || mention.name}${needsTrailingSpace ? ' ' : ''}`;
        const text = `${value.slice(0, replaceStart)}${insertion}${value.slice(end)}`;
        return {
            text,
            caret:replaceStart + insertion.length,
            mentions:existing ? records : [...records, mention],
            mention,
        };
    }

    function removeMention(options={}){
        const mention = options.mention || {};
        const text = String(options.text || '')
            .replace(mentionPattern(mention.marker || mention.name), '')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
        const id = String(mention.id || '');
        const url = String(mention.url || '');
        return {
            text,
            mentions:normalizeMentions(options.mentions).filter(item => id ? item.id !== id : item.url !== url),
        };
    }

    function removeMentionOccurrence(options={}){
        const mention = options.mention || {};
        const value = String(options.text || '');
        const records = normalizeMentions(options.mentions);
        const requestedIndex = Number(options.occurrenceIndex);
        const occurrenceIndex = Number.isFinite(requestedIndex) ? Math.max(0, Math.trunc(requestedIndex)) : 0;
        const pattern = mentionPattern(mention.marker || mention.name);
        const matches = [...value.matchAll(pattern)];
        const match = matches[occurrenceIndex];
        if(!match) return {text:value, mentions:records, removed:false};

        const start = match.index;
        const end = start + match[0].length;
        let before = value.slice(0, start);
        let after = value.slice(end);
        if(before && after && /[ \t]$/.test(before) && /^[ \t]/.test(after)){
            before = before.replace(/[ \t]+$/, ' ');
            after = after.replace(/^[ \t]+/, '');
        }else if(!before){
            after = after.replace(/^[ \t]+/, '');
        }else if(!after){
            before = before.replace(/[ \t]+$/, '');
        }
        const text = `${before}${after}`;
        const hasRemainingOccurrence = mentionPattern(mention.marker || mention.name).test(text);
        const id = String(mention.id || '');
        const url = String(mention.url || '');
        return {
            text,
            mentions:hasRemainingOccurrence
                ? records
                : records.filter(item => id ? item.id !== id : item.url !== url),
            removed:true,
        };
    }

    function pruneMentions(text, records){
        return activeMentions(text, records);
    }

    function escapeMarkup(value){
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function inlineParts(text, records){
        const value = String(text || '');
        const mentions = normalizeMentions(records)
            .map(item => ({...item, marker:item.marker || item.name}))
            .sort((a, b) => String(b.marker).length - String(a.marker).length);
        const parts = [];
        let buffer = '';
        let index = 0;
        const flush = () => {
            if(!buffer) return;
            parts.push({type:'text', text:buffer});
            buffer = '';
        };
        while(index < value.length){
            let hit = null;
            if(value[index] === '@'){
                hit = mentions.find(item => {
                    const source = value.slice(index);
                    const match = mentionPattern(item.marker).exec(source);
                    return Boolean(match && match.index === 0);
                }) || null;
            }
            if(!hit){
                buffer += value[index];
                index += 1;
                continue;
            }
            flush();
            parts.push({
                type:'mention',
                id:hit.id,
                url:hit.url,
                thumbnail:hit.thumbnail || hit.url,
                name:hit.name,
                marker:hit.marker,
                label:hit.label || hit.marker,
                kind:hit.kind || 'image',
            });
            index += 1 + hit.marker.length;
        }
        flush();
        return parts;
    }

    function inlineText(parts){
        return (Array.isArray(parts) ? parts : []).map(part => {
            if(part?.type === 'mention') return `@${part.marker || part.label || part.name || '图片'}`;
            return String(part?.text || '');
        }).join('');
    }

    function inlineDomParts(root){
        const parts = [];
        const pushText = text => {
            if(!text) return;
            const last = parts[parts.length - 1];
            if(last?.type === 'text') last.text += text;
            else parts.push({type:'text', text});
        };
        const walk = node => {
            if(!node) return;
            if(node.nodeType === 3){
                pushText(node.textContent || '');
                return;
            }
            if(node.nodeType !== 1 && node !== root){
                Array.from(node.childNodes || []).forEach(walk);
                return;
            }
            if(node !== root && node.classList?.contains('classic-inline-mention-token')){
                const marker = node.dataset?.marker || node.dataset?.label || node.dataset?.name || '图片';
                parts.push({
                    type:'mention',
                    id:node.dataset?.mentionId || '',
                    url:node.dataset?.url || '',
                    thumbnail:node.dataset?.thumbnail || node.dataset?.url || '',
                    name:node.dataset?.name || marker,
                    marker,
                    label:marker,
                    kind:node.dataset?.kind || 'image',
                });
                return;
            }
            if(node !== root && node.tagName === 'BR'){
                pushText('\n');
                return;
            }
            const blockTags = new Set(['DIV','P','LI','SECTION','ARTICLE','BLOCKQUOTE']);
            const isBlock = node !== root && blockTags.has(node.tagName);
            if(isBlock && parts.length && !inlineText(parts).endsWith('\n')) pushText('\n');
            Array.from(node.childNodes || []).forEach(walk);
            if(isBlock && !inlineText(parts).endsWith('\n')) pushText('\n');
        };
        Array.from(root?.childNodes || []).forEach(walk);
        return parts;
    }

    function inlineEditorText(root){
        const parts = inlineDomParts(root);
        const text = inlineText(parts);
        const hasMention = parts.some(part => part?.type === 'mention');
        return !hasMention && text.replace(/\n/g, '') === '' ? '' : text;
    }

    function inlineHtml(text, records){
        return inlineParts(text, records).map(part => {
            if(part.type !== 'mention') return escapeMarkup(part.text).replace(/\n/g, '<br>');
            const title = part.name || part.label || '图片';
            return `<span class="classic-inline-mention-token" contenteditable="false" data-mention-id="${escapeMarkup(part.id)}" data-url="${escapeMarkup(part.url)}" data-thumbnail="${escapeMarkup(part.thumbnail)}" data-name="${escapeMarkup(part.name)}" data-marker="${escapeMarkup(part.marker)}" title="${escapeMarkup(title)}"><img src="${escapeMarkup(part.thumbnail || part.url)}" alt=""><button type="button" class="classic-inline-mention-remove" data-classic-inline-mention-remove="${escapeMarkup(part.id || part.url)}" title="移除 @ 标签" aria-label="移除 @ 标签"><span aria-hidden="true">&times;</span></button><span class="classic-inline-mention-token-label">${escapeMarkup(part.label)}</span></span>`;
        }).join('');
    }

    return {
        DEFAULT_MAX_REFS,
        activeMentions,
        buildChatMessage,
        buildCompositePromptRequest,
        buildPromptRequest,
        inlineHtml,
        inlineDomParts,
        inlineEditorText,
        inlineParts,
        inlineText,
        insertMention,
        normalizeMentions,
        pruneMentions,
        refKey,
        removeMention,
        removeMentionOccurrence,
        uniqueRefs,
    };
});

import {TorampClient} from './client';
import {browserTransport} from './transport';
import {Gateway} from './gateway';
import {PRODUCT_NAME, VERSION, PRODUCT_ICON} from './brand';
(function () {
    'use strict';
    if (window.TorampLink) return;
    if (window.FrameTorampSync) {
        Lampa.Noty.show('Сначала отключите прежний плагин Toramp и перезапустите Lampa.');
        return;
    }
    window.TorampLink = {version: VERSION};
    // The old plugin checks this marker; prevent it from starting after this one.
    window.FrameTorampSync = window.TorampLink;
    var maps = [], mapsScope = '', lastCard, busy = false, importing = false, timer;
    function profile() {
        var p = Lampa.Account && Lampa.Account.Permit;
        return p && p.sync && p.account && p.account.profile ? String(p.account.profile.id) : 'local';
    }
    var client = new TorampClient(browserTransport(window), function(html) {return new DOMParser().parseFromString(html,'text/html');});
    var gateway = new Gateway(client, localStorage, profile), authBusy = false;
    function scope() {return gateway.scope();}
    function connected() {return gateway.ready;}
    function read(s, name, fallback) {return gateway.read(s,name,fallback);}
    function save(s, name, value) {gateway.save(s,name,value);}
    function notify(text) {Lampa.Noty.show(text);}
    function back() {Lampa.Controller.toggle('content');}
    function settingsBack() {Lampa.Controller.toggle('settings_component');}
    function safe(text) {return String(text).replace(/[&<>"']/g,function(c) {return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
    function request(command,data,s) {return gateway.invoke(command,data,s);}
    var showsLoading = {}, showsGeneration = {};
    function forgetShows(s) {
        showsGeneration[s] = (showsGeneration[s] || 0) + 1;
        delete showsLoading[s];
        save(s,'showsCache',null);
    }
    function shows(s) {
        var cached=read(s,'showsCache',null), age=cached ? Date.now()-cached.time : Infinity;
        if(cached && age>=0 && age<60000) return Promise.resolve(cached.items);
        if(!showsLoading[s]) {
            var generation=showsGeneration[s] || 0;
            var job=request('shows',null,s).then(function(items) {
                if((showsGeneration[s] || 0)===generation) save(s,'showsCache',{time:Date.now(),items:items});
                return items;
            });
            showsLoading[s]=job;
            job.then(function(){if(showsLoading[s]===job)delete showsLoading[s];},function(){if(showsLoading[s]===job)delete showsLoading[s];});
        }
        // Render the last list immediately while refreshing it in the background.
        if(cached && age>=0 && age<86400000) {
            showsLoading[s].catch(function(e){save(s,'lastError',e.message);});
            return Promise.resolve(cached.items);
        }
        return showsLoading[s];
    }
    function parallelMap(items,limit,fn) {
        var next=0, results=[];
        function worker() {
            if(next>=items.length)return Promise.resolve();
            var index=next++;
            return Promise.resolve().then(function(){return fn(items[index]);}).then(function(value){results[index]=value;return worker();});
        }
        var workers=[];
        for(var i=0;i<Math.min(limit,items.length);i++)workers.push(worker());
        return Promise.all(workers).then(function(){return results;});
    }
    function road(mapping, episode, name) {
        if (!Lampa.Timeline.watchedEpisode) throw Error('Нужна версия Lampa с Timeline.watchedEpisode');
        return Lampa.Timeline.watchedEpisode({original_name: name || mapping.originalName}, episode.season, episode.episode, true);
    }
    function names(mapping) { return [mapping.originalName].concat(mapping.aliases || []).filter(function (n,i,a) {return a.indexOf(n)===i;}); }
    function capture(s) {
        if (s !== mapsScope || scope() !== s) return;
        var queue = read(s, 'queue', {});
        maps.forEach(function (m) {
            var ids = queue[m.tmdbId] || [];
            m.episodes.forEach(function (e) { if (names(m).some(function(n){return road(m,e,n).percent>=95;}) && ids.indexOf(e.torampEpisodeId) < 0) ids.push(e.torampEpisodeId); });
            queue[m.tmdbId] = ids;
        });
        save(s, 'queue', queue);
    }
    function synchronize(showMessage) {
        var s = scope();
        if (busy || !connected()) { if (showMessage) notify(busy ? 'Синхронизация уже идёт' : 'Сначала войдите в Toramp'); return; }
        busy = true;
        request('mappings', null, s).then(function (list) {
            if (scope() !== s) throw Error('Профиль изменился');
            maps = list; mapsScope = s; capture(s);
            return maps.reduce(function (promise, m) {
                return promise.then(function () {
                    if (scope() !== s) throw Error('Профиль изменился');
                    return request('sync', {tmdbId:m.tmdbId, watched:read(s, 'queue', {})[m.tmdbId] || []}, s).then(function (result) {
                        if (scope() !== s) throw Error('Профиль изменился');
                        importing = true;
                        try {
                            m.episodes.forEach(function (e) {
                                if (result.watched.indexOf(e.torampEpisodeId) < 0) return;
                                names(m).forEach(function(n) {
                                    var r = road(m, e, n);
                                    if (r.percent >= 95) return;
                                    Lampa.Timeline.update({hash:r.hash,percent:95,time:r.duration ? Math.max(r.time || 0,r.duration * .95) : r.time || 0,duration:r.duration || 0,profile:r.profile,received:true});
                                });
                            });
                        } finally { importing = false; }
                        var q = read(s, 'queue', {});
                        q[m.tmdbId] = (q[m.tmdbId] || []).filter(function (id) { return result.acknowledged.indexOf(id) < 0; });
                        save(s, 'queue', q);
                    });
                });
            }, Promise.resolve());
        }).then(function () { save(s, 'lastSync', Date.now()); save(s, 'lastError', ''); if (showMessage) notify('Toramp: просмотренные серии синхронизированы'); })
        .catch(function (e) { if (showMessage) notify(e.message); save(s, 'lastError', e.message); })
        .then(function () { busy = false; });
    }
    function pair() {
        if(authBusy){notify('Проверка входа уже выполняется');return;}
        if(connected()){connectionInfo();return;}
        authBusy=true;notify('Проверяем вход в Toramp…');
        gateway.restore().then(function(active){
            authBusy=false;
            if(active){notify('Toramp подключён: '+decodeURIComponent(gateway.account));synchronize(false);drainAuto(scope());return;}
            Lampa.Input.edit({title:'Логин Toramp',value:'',free:true,nosave:true,nomic:true,keyboard:'lampa'},function(username){
                if(!username){settingsBack();return;}
                Lampa.Input.edit({title:'Пароль Toramp',value:'',free:true,nosave:true,nomic:true,password:true,keyboard:'lampa'},function(password){
                    settingsBack();if(!password)return;authBusy=true;notify('Входим в Toramp…');
                    var job=gateway.login(username,password);username='';password='';
                    job.then(function(){notify('Вход выполнен. Один аккаунт Toramp используется всеми профилями на устройстве.');synchronize(false);drainAuto(scope());})
                        .catch(errorMessage).then(function(){authBusy=false;});
                });
            });
        }).catch(function(e){authBusy=false;errorMessage(e);});
    }
    function connectionInfo() {
        var s=scope(), pending=read(s,'queue',{}), additions=read(s,'autoQueue',{});
        var count=Object.keys(pending).reduce(function(n,k){return n+pending[k].length;},Object.keys(additions).length);
        var last=read(s,'lastSync',0), lastError=read(s,'lastError','');
        var items=[{title:connected()?'Аккаунт: '+safe(decodeURIComponent(gateway.account)):'Вход не выполнен',subtitle:'Один аккаунт Toramp на устройство; очереди разделены по профилям Lampa.'},
            {title:busy?'Синхронизация выполняется':'Ожидают отправки: '+count,subtitle:last?'Последняя синхронизация: '+new Date(last).toLocaleString():'Успешной синхронизации ещё не было.'}];
        if(lastError)items.push({title:'Последняя ошибка',subtitle:safe(lastError)});
        items.push({title:connected()?'Проверить подключение':'Войти в Toramp',check:true});
        if(connected())items.push({title:'Выйти из Toramp на устройстве',logout:true,subtitle:'Очередь останется сохранённой для прежнего аккаунта.'});
        Lampa.Select.show({title:PRODUCT_NAME,items:items,onBack:settingsBack,onSelect:function(choice){
            settingsBack();if(choice.check){if(!connected()){pair();return;}
                gateway.restore().then(function(active){notify(active?'Подключение активно':'Сессия истекла. Войдите снова.');}).catch(errorMessage);
            }
            if(choice.logout)Lampa.Select.show({title:'Выйти из Toramp для всех профилей?',items:[{title:'Выйти',confirm:true},{title:'Отмена'}],onBack:settingsBack,onSelect:function(v){
                settingsBack();if(!v.confirm)return;gateway.logout().then(function(){maps=[];mapsScope='';notify('Вы вышли из Toramp.');}).catch(errorMessage);
            }});
        }});
    }
    function tmdb(path) {
        return new Promise(function (resolve,reject) {
            Lampa.Api.sources.tmdb.get(path, {}, resolve, function () { reject(Error('Не удалось загрузить серии Lampa')); });
        });
    }
    var categories = [
        {id:'watching',title:'Смотрю'}, {id:'completed',title:'Посмотрел'},
        {id:'want-to-see',title:'Хочу посмотреть'}, {id:'on-hold',title:'Отложено'}, {id:'dropped',title:'Брошено'}
    ];
    var linking = {};
    function norm(v) { return String(v || '').toLowerCase().replace(/\s*\((show|anime)\)\s*$/i,'').replace(/[\s:.,!?'"’\-–—()]/g,''); }
    function year(v) { return String(v.year || v.first_air_date || '').slice(0,4); }
    function exactCandidates(seed, candidates) {
        var names = [seed.original_name,seed.name,seed.title].filter(Boolean).map(norm);
        return candidates.filter(function (c) {
            return year(seed) && year(seed) === year(c) && [c.original_name,c.name,c.title].filter(Boolean).some(function (n) {return names.indexOf(norm(n)) >= 0;});
        });
    }
    function chooseMatch(seed, candidates, title, trusted) {
        var exact = exactCandidates(seed,candidates);
        if (trusted && candidates.length === 1) return Promise.resolve(candidates[0]);
        if (exact.length === 1) return Promise.resolve(exact[0]);
        if (!candidates.length) return Promise.reject(Error('Сериал не найден. Попробуйте другое название.'));
        return new Promise(function (resolve,reject) {
            Lampa.Select.show({title:title,items:candidates.map(function (c) {
                return {title:safe(c.name || c.title || c.original_name),subtitle:safe((c.original_name || '') + ' ' + year(c)),card:c};
            }),onBack:function () {back(); reject(Error('cancelled'));},onSelect:function (v) {back();resolve(v.card);}});
        });
    }
    function errorMessage(e) { if(e.message !== 'cancelled') notify(e.message); }
    function tmdbCard(card) {
        if (!card.source || card.source === 'tmdb') return Promise.resolve(card);
        if (card.source !== 'cub' && card.source !== 'toramp') return Promise.reject(Error('Этот источник пока не поддерживается: ' + card.source));
        function search() {
            return tmdb('search/tv?query=' + encodeURIComponent(card.original_name || card.name || card.title))
                .then(function (r) {return chooseMatch(card,r.results || [],'Какой это сериал?');});
        }
        if (/^tt\d+$/.test(card.imdb_id || '')) return tmdb('find/' + card.imdb_id + '?external_source=imdb_id').then(function (r) {
            return r.tv_results && r.tv_results.length ? chooseMatch(card,r.tv_results,'Какой это сериал?',true) : search();
        });
        return search();
    }
    function mapped(s,id) {return request('mappings',null,s).then(function (list) {return list.filter(function (m) {return m.tmdbId === Number(id);})[0];});}
    function prepareMapping(card,s,sid,silent) {
        var guard = s + ':' + card.id;
        if (linking[guard]) return linking[guard];
        var job = mapped(s,card.id).then(function (existing) {
            if(scope() !== s) throw Error('cancelled');
            if (existing && existing.torampId === sid) {
                if(names(existing).indexOf(card.original_name)<0) return request('alias',{tmdbId:Number(card.id),name:card.original_name},s).then(function(m){synchronize(false);return m;});
                synchronize(false);return existing;
            }
            return tmdb('tv/' + card.id).then(function (full) {
                var episodes = [], today = new Date().toISOString().slice(0,10);
                return parallelMap((full.seasons || []).filter(function(v){return v.season_number>0;}),3,function(season) {
                    return tmdb('tv/'+card.id+'/season/'+season.season_number);
                }).then(function(seasons) {
                    seasons.forEach(function(r){(r.episodes || []).forEach(function(e) {
                        if(e.air_date && e.air_date<=today)episodes.push({season:e.season_number,episode:e.episode_number,air_date:e.air_date});
                    });});
                    if(scope() !== s) throw Error('cancelled');
                    return request('preview',{tmdbId:Number(card.id),torampId:sid,originalName:card.original_name,episodes:episodes},s);
                });
            }).then(function (preview) {
                if(scope() !== s) throw Error('cancelled');
                function confirm() {
                    return request('confirm',{confirmation:preview.confirmation},s).then(function (m) {synchronize(!silent);return m;});
                }
                if (!preview.mapping.skipped.length) return confirm();
                if(silent) return null;
                return new Promise(function (resolve,reject) {
                    Lampa.Select.show({title:'Часть серий отличается',items:[
                        {title:'Синхронизировать совпавшие: ' + preview.mapping.episodes.length,subtitle:'Пропущено: ' + preview.mapping.skipped.length,confirm:true},
                        {title:'Отмена'}
                    ],onBack:function () {back();reject(Error('cancelled'));},onSelect:function (v) {
                        back();if(!v.confirm || scope() !== s) {reject(Error('cancelled'));return;}
                        confirm().then(resolve,reject);
                    }});
                });
            });
        });
        linking[guard] = job;
        job.then(function () {delete linking[guard];},function () {delete linking[guard];});
        return job;
    }
    function resolveToramp(card,s) {
        return shows(s).then(function (list) {
            var exact=exactCandidates(card,list);
            if(exact.length===1) return exact[0];
            return request('search',{query:card.original_name || card.name},s).then(function (items) {
                return chooseMatch(card,items,'Выберите сериал в Toramp');
            });
        });
    }
    function statusMenu(show,s,after) {
        var ids={'want_to_see':'want-to-see','on_hold':'on-hold'};
        Lampa.Select.show({title:show.status==='no_status'?'Добавить в Toramp':'Статус в Toramp',items:categories.filter(function (c) {
            return show.allowed.indexOf(c.id)>=0 || (ids[show.status] || show.status)===c.id;
        }).map(function (c) {return {title:c.title,category:c.id,selected:(ids[show.status] || show.status)===c.id};}),onBack:back,onSelect:function (choice) {
            back();if(scope()!==s)return;
            request('status',{id:show.id,category:choice.category},s).then(function (result) {
                if(scope()!==s)return;
                forgetShows(s); notify('Toramp: ' + choice.title);if(after)after(result);
            }).catch(errorMessage);
        }});
    }
    function bind(card) {
        if(!card || !card.original_name){notify('Откройте карточку сериала.');return;}
        var s=scope();if(!connected()){pair();return;}
        notify('Проверяем Toramp…');
        tmdbCard(card).then(function (resolved) {
            if(scope()!==s)throw Error('cancelled');
            var linkedCard=Object.assign({},resolved,{original_name:card.original_name,source:'tmdb'});
            return resolveToramp(resolved,s).then(function (show) {return request('show',{id:show.id},s);}).then(function (show) {
                if(scope()!==s)return;
                if(show.status==='no_status') {
                    statusMenu(show,s,function () {prepareMapping(linkedCard,s,show.id,false).catch(errorMessage);});
                } else {
                    Lampa.Select.show({title:PRODUCT_NAME,items:[{title:'Синхронизировать просмотренное',sync:true},{title:'Изменить статус'}],onBack:back,onSelect:function (v) {
                        back();if(scope()!==s)return;
                        if(v.sync)prepareMapping(linkedCard,s,show.id,false).catch(errorMessage);
                        else statusMenu(show,s);
                    }});
                }
            });
        }).catch(errorMessage);
    }
    function autoLink(card) {
        var s=scope();if(!connected() || !card || !card.original_name)return;
        shows(s).then(function (list) {
            if(scope()!==s)return;
            var match=exactCandidates(card,list);
            if(match.length!==1)return;
            // Background work never opens a selection dialog.
            if(!card.source || card.source==='tmdb') return prepareMapping(card,s,match[0].id,true);
            if(card.source==='cub' && /^tt\d+$/.test(card.imdb_id || '')) return tmdb('find/'+card.imdb_id+'?external_source=imdb_id').then(function (r) {
                if(r.tv_results && r.tv_results.length===1 && scope()===s)
                    return prepareMapping(Object.assign({},r.tv_results[0],{original_name:card.original_name}),s,match[0].id,true);
            });
        }).catch(function (e) {save(s,'lastError',e.message);});
    }
    // Diagnostics stay on the device. No telemetry endpoint is shipped.
    function diagnostic() {}
    var autoJobs={}, autoDone={}, autoRetry={}, autoBusy=false, playback=null;
    function quietCard(card) {
        if(!card.source || card.source==='tmdb')return Promise.resolve(card);
        if(card.source!=='cub')return Promise.resolve(null);
        if(/^tt\d+$/.test(card.imdb_id || ''))return tmdb('find/'+card.imdb_id+'?external_source=imdb_id').then(function(r) {
            return r.tv_results && r.tv_results.length===1 ? Object.assign({},r.tv_results[0],{original_name:card.original_name || r.tv_results[0].original_name}) : null;
        });
        return tmdb('search/tv?query='+encodeURIComponent(card.original_name || card.name || card.title)).then(function(r) {
            var matches=exactCandidates(card,r.results || []);return matches.length===1 ? matches[0] : null;
        });
    }
    function autoWatch(card,s) {
        return quietCard(card).then(function(resolved) {
            if(!resolved || scope()!==s)return null;
            return shows(s).then(function(list) {
                var matches=exactCandidates(resolved,list);
                if(matches.length===1)return matches[0];
                return request('search',{query:resolved.original_name || resolved.name},s).then(function(items) {
                    var found=exactCandidates(resolved,items);return found.length===1 ? found[0] : null;
                });
            }).then(function(found) {
                if(!found || scope()!==s)return null;
                return request('show',{id:found.id},s).then(function(meta) {
                    if(scope()!==s)return null;
                    if(meta.status==='watching')return found;
                    if(meta.allowed.indexOf('watching')<0)return null;
                    return request('status',{id:found.id,category:'watching'},s).then(function() {
                        forgetShows(s);diagnostic('status_saved',s);return found;
                    });
                }).then(function(added) {
                    if(!added || scope()!==s)return null;
                    // Identity is enough for the library status. Episode mapping stays strict.
                    return prepareMapping(resolved,s,found.id,true).then(function(mapping) {
                        if(!mapping)diagnostic('episodes_partial',s);
                        return added;
                    }).catch(function(e){save(s,'lastError',e.message);diagnostic('episodes_failed',s);return added;});
                });
            });
        });
    }
    function drainAuto(s) {
        if(scope()!==s || !connected())return;
        var queue=read(s,'autoQueue',{});
        Object.keys(queue).forEach(function(id) {
            var guard=s+':'+id;
            if(autoBusy || autoJobs[guard] || (autoRetry[guard] || 0)>Date.now())return;
            autoBusy=true;autoJobs[guard]=true;diagnostic('resolving',s);
            autoWatch(queue[id],s).then(function(result) {
                if(scope()!==s)return;
                var latest=read(s,'autoQueue',{});delete latest[id];save(s,'autoQueue',latest);
                autoDone[guard]=true;diagnostic(result?'done':'ambiguous',s);
                if(!result)save(s,'lastError','Автосинхронизация: нет однозначного совпадения сериала или серий.');
            }).catch(function(e) {
                autoRetry[guard]=Date.now()+60000;save(s,'lastError',e.message);diagnostic('failure',s);
            }).then(function(){delete autoJobs[guard];autoBusy=false;});
        });
    }
    function playbackProgress(data,s) {
        if(!data || data.iptv || data.tv || scope()!==s || !connected())return;
        var card=data.card, road=data.timeline;
        if(!card || !road){diagnostic(!card?'no_card':'no_timeline',s,{hasCard:!!card,hasTimeline:!!road});return;}
        if(!(Number(road.time)>=60 && Number(road.duration)>=300)){diagnostic('waiting',s,{time:Math.floor(Number(road.time)||0),duration:Math.floor(Number(road.duration)||0)});return;}
        // The player's own card identifies the title; an unrelated open card never does.
        if(card.media_type==='movie' || card.release_date || !(card.media_type==='tv' || card.first_air_date || card.name))return;
        if(!card.id || !card.original_name){diagnostic('incomplete_card',s,{hasId:!!card.id,hasName:!!card.original_name});return;}
        var id=String(card.source || 'tmdb')+':'+card.id, guard=s+':'+id;
        if(autoDone[guard])return;
        var queue=read(s,'autoQueue',{});
        queue[id]={id:card.id,source:card.source,media_type:'tv',original_name:card.original_name,name:card.name,title:card.title,
            first_air_date:card.first_air_date,year:card.year,imdb_id:card.imdb_id};
        save(s,'autoQueue',queue);drainAuto(s);
    }
    var libraryTabs=[{id:'continue',title:'Продолжить'},{id:'new',title:'Непросмотренные серии'}].concat(categories);
    function dashboardEntries(result,category,linked) {
        var entries=(result.items || []).map(function(v){
            if(category!=='continue')return v;
            var mapping=(linked || []).filter(function(m){return m.torampId===v.id;})[0];
            if(!mapping)return v;
            var partial=mapping.episodes.map(function(e){return {episode:e,road:road(mapping,e)};}).filter(function(e){return e.road.percent>0 && e.road.percent<95;});
            partial.sort(function(a,b){return (b.road.updated || 0)-(a.road.updated || 0);});
            if(!partial.length)return v;
            var e=partial[0].episode;
            return Object.assign({},v,{episode_progress:Object.assign({},v.episode_progress,{available:Math.max(1,v.episode_progress.available),next:{season:e.season,episode:e.episode}})});
        }).filter(function(v){return v.episode_progress && v.episode_progress.available>0;});
        return entries.map(function(v){
            var next=v.episode_progress.next;
            return Object.assign({},v,{progress:category==='new' ? 'Непросмотренных: '+v.episode_progress.available :
                'С'+next.season+' · серия '+next.episode,nextEpisode:next});
        });
    }
    function openShow(show,s) {
        request('mappings',null,s).then(function (list) {
            var m=list.filter(function (v) {return v.torampId===show.id;})[0];
            if(m)return tmdb('tv/'+m.tmdbId);
            return request('show',{id:show.id},s).then(function (meta) {
                return tmdbCard({source:'toramp',title:meta.title,original_name:meta.title,year:meta.year});
            });
        }).then(function (card) {
            if(scope()!==s)return;
            card.source='tmdb';
            if(show.nextEpisode){
                Lampa.Activity.push({component:'episodes',title:card.name || card.title,card:card,source:'tmdb',season:show.nextEpisode.season});
                notify('Следующая: сезон '+show.nextEpisode.season+', серия '+show.nextEpisode.episode);
            }else Lampa.Router.call('full',card);
            prepareMapping(card,s,show.id,false).catch(errorMessage);
        }).catch(errorMessage);
    }
    function library() {
        if(!connected()){pair();return;}
        Lampa.Activity.push({component:'toramp_link_library',title:PRODUCT_NAME,category:read(scope(),'category','continue'),page:1});
    }
    function Library(object) {
        var s=scope(), comp=Lampa.Maker.make('Category',object), disposed=false;
        var tabs=$('<div class="toramp-tabs"></div>'), status=$('<div class="toramp-status"></div>'), header=$('<div></div>').append(tabs,status), current=object.category || 'continue';
        var seen={}, refreshTimer, linked=[], painted=false;
        function moveTab(step) {
            var buttons=tabs.find('.selector'), index=buttons.index(tabs.find('.focus'));
            if(index<0)index=buttons.index(tabs.find('[data-category="'+current+'"]'));
            var next=index+step;
            if(next<0){Lampa.Controller.toggle('menu');return;}
            if(next<buttons.length)Lampa.Controller.collectionFocus(buttons[next],tabs);
        }
        function focusTabs() {
            Lampa.Controller.add('toramp_tabs',{
                toggle:function () {Lampa.Controller.collectionSet(tabs);Lampa.Controller.collectionFocus(tabs.find('[data-category="'+current+'"]')[0],tabs);},
                left:function () {moveTab(-1);},right:function () {moveTab(1);},
                up:function () {if(window.Navigator.canmove('up'))window.Navigator.move('up');else Lampa.Controller.toggle('head');},
                down:function () {if(window.Navigator.canmove('down'))window.Navigator.move('down');else if(comp.items && comp.items.length)comp.start();},
                back:function () {Lampa.Activity.backward();}
            });
            Lampa.Controller.toggle('toramp_tabs');
        }
        libraryTabs.forEach(function (category) {
            var button=$('<div class="simple-button selector"></div>').text(category.title).attr('data-category',category.id);
            button.toggleClass('toramp-tab-active',category.id===current);
            button.on('hover:enter',function () {
                if(current===category.id)return;
                save(s,'category',category.id);Lampa.Activity.replace({component:'toramp_link_library',title:PRODUCT_NAME,category:category.id,page:1});
            });tabs.append(button);
        });
        function paint(entries,special) {
            if(disposed || scope()!==s)return;
            var fresh=entries.filter(function(v){if(seen[v.id])return false;seen[v.id]=true;return true;});
            if(fresh.length){
                $(comp.body).find('.toramp-empty').remove();
                var data={results:fresh.map(function(v){
                    return {id:v.id,title:v.title,name:v.title,original_name:v.title,poster:v.poster,first_air_date:v.year?v.year+'-01-01':'',source:'toramp',toramp:v,params:{}};
                }),page:1,total_pages:1};
                if(painted)comp.emit('build',data);else{comp.build(data);painted=true;}
            }else if(!painted && !status.text()){
                $(comp.body).find('.toramp-empty').remove();
                $(comp.body).append($('<div class="empty__title toramp-empty"></div>').text(special?'Нет доступных непросмотренных серий':'Здесь пока нет сериалов'));
                comp.activity.loader(false);focusTabs();
            }
        }
        function refreshDashboard() {
            if(disposed || scope()!==s)return;
            request('dashboard',null,s).then(function(result){
                if(disposed || scope()!==s)return;
                status.text(result.refreshing?'Обновляем список серий…':result.errors || result.pending?'Не удалось проверить часть сериалов. Повторим позже.':'');
                paint(dashboardEntries(result,current,linked),true);
                comp.activity.loader(false);
                if(!painted)focusTabs();
                if(result.refreshing)refreshTimer=setTimeout(refreshDashboard,2500);
            }).catch(function(e){
                if(disposed)return;
                status.text(e.message);comp.activity.loader(false);if(!painted)focusTabs();
            });
        }
        comp.use({
            onCreate:function () {
                $(this.html).prepend(header);this.scroll.minus(header);
                if(current==='continue' || current==='new') {
                    status.text('Обновляем список серий…');
                    request('mappings',null,s).then(function(list){linked=list;refreshDashboard();}).catch(function(e){status.text(e.message);comp.activity.loader(false);focusTabs();});
                }else shows(s).then(function(list){paint(list.filter(function(v){return v.category===current;}),false);}).catch(function(e){
                    if(disposed)return;status.text(e.message);comp.activity.loader(false);focusTabs();
                });
            },
            onInstance:function (item,data) {
                item.use({onEnter:function () {openShow(data.toramp,s);},onMenu:function () {
                    request('show',{id:data.toramp.id},s).then(function (show) {statusMenu(show,s,function () {comp.activity.refresh();});}).catch(errorMessage);
                },onCreate:function () {
                    if(data.toramp.progress)$(this.html).find('.card__view').append($('<div class="toramp-progress"></div>').text(data.toramp.progress));
                }});
            },
            onController:function (controller) {
                controller.up=function () {if(window.Navigator.canmove('up'))window.Navigator.move('up');else focusTabs();};
            },
            onDestroy:function () {disposed=true;clearTimeout(refreshTimer);header.remove();}
        });
        return comp;
    }
    function setting(name, title, callback) {
        Lampa.SettingsApi.addParam({component:'toramp_link',param:{name:name,type:'button'},field:{name:title},onRender:function (item) {item.on('hover:enter',callback);}});
    }
    function start() {
        var initialScope=scope();
        if(read(initialScope,'cacheVersion','')!==window.TorampLink.version){forgetShows(initialScope);save(initialScope,'cacheVersion',window.TorampLink.version);}
        Lampa.Component.add('toramp_link_library',Library);
        if(typeof document !== 'undefined' && !document.getElementById('toramp-link-style')) {
            var style=document.createElement('style');style.id='toramp-link-style';
            style.textContent='.toramp-status{padding:0 1.5em .8em;font-size:.8em}.toramp-status:empty{display:none}.toramp-tabs{display:flex;padding:1em 1.5em;flex-wrap:wrap}.toramp-tabs .simple-button{margin:0 .6em .6em 0}.toramp-tabs .toramp-tab-active{box-shadow:inset 0 -2px currentColor}.toramp-progress{position:absolute;bottom:.5em;right:.5em;padding:.2em .4em;background:#20202b;color:#fff;border-radius:.2em;font-size:.8em}';
            document.head.appendChild(style);
        }
        Lampa.SettingsApi.addComponent({component:'toramp_link',name:PRODUCT_NAME,icon:PRODUCT_ICON});
        var icon = PRODUCT_ICON;
        var openLibrary = function () { back(); library(true); };
        if (Lampa.Menu && Lampa.Menu.addButton) {
            Lampa.Menu.addButton(icon,PRODUCT_NAME,openLibrary).attr('data-action','toramp_link');
        } else {
            var menuItem = $('<li class="menu__item selector" data-action="toramp_link"><div class="menu__ico">' + icon + '</div><div class="menu__text">' + PRODUCT_NAME + '</div></li>');
            menuItem.on('hover:enter',openLibrary);
            $('.menu__list').first().append(menuItem);
        }
        setting('toramp_link_connection','Аккаунт и синхронизация',connectionInfo);
        setting('toramp_link_pair','Войти в Toramp',pair);
        setting('toramp_link_bind','Связать открытый сериал с Toramp',function () {
            var active = Lampa.Activity && Lampa.Activity.active ? Lampa.Activity.active() : null;
            bind(active && active.component === 'full' && active.card ? active.card : lastCard);
        });
        setting('toramp_link_sync','Синхронизировать сейчас',function () {synchronize(true);});
        Lampa.Listener.follow('full',function (event) {
            if ((event.type !== 'start' && event.type !== 'complite') || !event.data || !event.data.movie) return;
            lastCard = event.data.movie;
            if (event.type !== 'complite') return;
            autoLink(lastCard);
            if (!lastCard.original_name) return;
            var card = lastCard;
            var button = $('<div class="full-start__button selector"><span>Toramp</span></div>');
            button.on('hover:enter',function () {bind(card);});
            var target = event.body.find('.full-start-new__buttons,.full-start__buttons').first();
            if (target.length) target.append(button);
        });
        if(Lampa.Player && Lampa.Player.listener) {
            Lampa.Player.listener.follow('start',function(data){playback={data:data,scope:scope()};diagnostic('player_start',scope(),{hasCard:!!data.card,hasTimeline:!!data.timeline});});
            Lampa.Player.listener.follow('destroy',function(){
                if(playback)playbackProgress(playback.data,playback.scope);
                playback=null;
            });
            setInterval(function(){
                if(playback)playbackProgress(playback.data,playback.scope);
                drainAuto(scope());
            },15000);
        }
        diagnostic('ready',scope(),{hasPlayer:!!(Lampa.Player && Lampa.Player.listener)});
        gateway.restore().then(function(active){if(active){synchronize(false);drainAuto(scope());}}).catch(function(e){save(scope(),'lastError',e.message);});
        Lampa.Listener.follow('state:changed',function (event) {
            if (importing || event.target !== 'timeline' || event.reason !== 'update') return;
            try {capture(scope());} catch (e) {return;}
            clearTimeout(timer); timer = setTimeout(function () {synchronize(false);},3000);
        });
        synchronize(false);
        setInterval(function () {synchronize(false);},180000);
    }
    if (window.appready) start();
    else Lampa.Listener.follow('app',function (e) {if(e.type === 'ready') start();});
})();

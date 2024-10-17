process.env.TZ = 'Australia/Melbourne'; // force AEST/AEDT

const express = require('express');
const expressWs = require('express-ws');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');

const metroLines = new Map(Object.entries(JSON.parse(fs.readFileSync('metrolines.json'))));

const API_ID = process.env.API_ID, API_KEY = process.env.API_KEY;
console.log('Using PTV timetable API credentials with ID', API_ID);
const API_BASE = process.env.API_BASE || 'https://timetableapi.ptv.vic.gov.au/v3';
console.log('PTV timetable API base URL:', API_BASE);

const generateURL = (query) => {
    query = API_BASE + query + (query.includes('?') ? '&' : '?') + 'devid=' + API_ID;
    const url = new URL(query);
    const sig = crypto.createHmac('sha1', API_KEY).update(url.pathname + url.search).digest('hex').toUpperCase();
    query += '&signature=' + sig;
    return query;
};

async function main() {
    let STATION = process.env.STATION;
    if (isNaN(STATION)) {
        console.log(`Targeting station with name/search term '${STATION}'.`);
        const searchResult = await axios.get(generateURL(`/search/${encodeURIComponent(STATION)}?route_types=0&include_outlets=false`)); // TODO: support V/Line only stations
        if (!searchResult.data.stops.length) {
            console.error(`Cannot find any station matching the given search term`);
            process.exit(1);
        }
        STATION = searchResult.data.stops[0].stop_id;
        console.debug(`Targeting station with ID ${STATION} (${searchResult.data.stops[0].stop_name}, ${searchResult.data.stops[0].stop_suburb}).`);
    } else {
        console.log(`Targeting station with ID ${STATION}.`);
    }

    const app = express();
    const appWs = expressWs(app); // WebSocket
    app.use(express.static('static'));
    app.use('/assets/js/axios', express.static('node_modules/axios/dist'));
    app.use(express.json());
    
    app.ws('/ws/:plat', (ws, req) => {
        const plat = req.params.plat;
        console.log(`Client connected, listening to platform ${plat}`);
        ws.pnum = plat;

        ws.send(JSON.stringify({ command: 'refresh' }));
    });

    let departures = {}; // platforms => list of runs sorted by time

    app.get('/departures/:plat', (req, res) => {
        const plat = req.params.plat;
        if (!departures.hasOwnProperty(plat)) return res.status(404).json({ message: '404 Not Found' });
        const platform = departures[plat];
        // if (platform.length == 0 || platform[0].time.getTime() - Date.now() >= (4 * 60 + 1) * 60 * 1000) return res.status(200).json([]);
        const resp = [];
        for (let i = 0; i < 3 && i < platform.length; i++) {
            resp.push({
                type: platform[i].type,
                run: platform[i].run,
                time: platform[i].time.getTime(),
                dest: platform[i].dest,
                subtitle: platform[i].subtitle,
                group: platform[i].colour,
                stations: platform[i].stations
            });
        }
        res.status(200).json(resp);
    });

    app.get('/departures/:plat/after/:run', (req, res) => {
        const plat = req.params.plat, run = req.params.run;
        if (departures.hasOwnProperty(plat)) {
            const platform = departures[plat];
            for (let i = 0; i < platform.length - 1; i++) {
                if (platform[i].run == run) {
                    return res.status(200).json({
                        type: platform[i + 1].type,
                        run: platform[i + 1].run,
                        time: platform[i + 1].time.getTime(),
                        dest: platform[i + 1].dest,
                        subtitle: platform[i + 1].subtitle,
                        group: platform[i + 1].colour,
                        stations: platform[i + 1].stations
                    });
                }
            }
        }
        res.status(404).json({ message: '404 Not Found' });
    });
    
    app.get('/departures/:plat/:idx', (req, res) => {
        const plat = req.params.plat, i = parseInt(req.params.idx);
        if (!departures.hasOwnProperty(plat) || departures[plat].length <= i) return res.status(404).json({ message: '404 Not Found' });
        const platform = departures[plat];
        // if (platform.length == 0 || platform[0].time.getTime() - Date.now() >= (4 * 60 + 1) * 60 * 1000) return res.status(200).json({});
        res.status(200).json({
            type: platform[i].type,
            run: platform[i].run,
            time: platform[i].time.getTime(),
            dest: platform[i].dest,
            subtitle: platform[i].subtitle,
            group: platform[i].colour,
            stations: platform[i].stations
        });
    });

    const fetchPattern = async (type, run, saveAll = false) => {
        // console.debug(type, run);
        const stations = [];
        const resp = await axios.get(generateURL(`/pattern/run/${run}/route_type/${type}?expand=Stop&expand=Run&include_skipped_stops=true`));
        let startSaving = saveAll;
        let note = '';
        for (const stop of resp.data.departures) {
            // console.log(stop);
            if (!startSaving) {
                if (stop.stop_id == STATION) {
                    startSaving = true;
                    note = stop.departure_note;
                }
                else continue; // wait until we hit our station
            }

            stations.push({ id: stop.stop_id, name: resp.data.stops[stop.stop_id].stop_name.replace(/-.*$/gm, ''), skipped: false }); // save this stop
            for (const skipStop of stop.skipped_stops) stations.push({ id: skipStop.stop_id, name: skipStop.stop_name.replace(/ Station/gm, '').replace(/-.*$/gm, ''), skipped: true }); // save skipped stops
        }
        return {
            stations: stations,
            note: note,
            run: resp.data.runs[run]
        };
    };

    const isCBDStation = (id) => {
        return [
            1068, /* Flagstaff */
            1120, /* Melbourne Central */
            1155, /* Parliament */
            1181, /* Southern Cross */
            1071, /* Flinders Street */
        ].includes(id);
    };
    const cbdStation = isCBDStation(STATION);
    if (cbdStation) console.log('This station is in Melbourne CBD');

    const shortenName = (name) => {
        return name.replace(/^North /gm, 'N ').replace(/^East /gm, 'E ').replace(/^West /gm, 'W ').replace(/^South /gm, 'S ').replace(/^Upper /gm, 'U ');
    };

    const routeColours = new Map();

    const fetchDepartureDetails = async (dep) => {
        const result = await fetchPattern(dep.type, dep.run);

        // console.log(result);
        // console.log(result.run);
        dep.stations = result.stations;
        dep.dest = result.run.destination_name;

        /* figure out actual destination */
        if (isCBDStation(result.run.final_stop_id)) {
            if (
                cbdStation /* CBD stations show destinations away from the CBD */
                || dep.colour == 'crosscity' /* Frankston/Werribee/Williamstown service - may extend beyond CBD stations e.g. Flinders Street or Southern Cross */
            ) {
                if (result.run.interchange && result.run.interchange.distributor) {
                    /* next service is in distributor */
                    const dist = result.run.interchange.distributor;
                    dep.dest = dist.destination_name;
                    const result2 = await fetchPattern(dep.type, dist.run_ref, true);
                    // console.debug(result);
                    // console.debug(result2);
                    if (routeColours.get(result2.run.route_id) == dep.colour) {
                        const nextStations = result2.stations;
                        for (let i = 0; i < nextStations.length; i++) {
                            // console.debug(nextStations[i]);
                            if (nextStations[i].id == result.run.final_stop_id) {
                                // console.debug(`Concatenating from index ${i}`);
                                dep.stations = dep.stations.concat(nextStations.slice(i + 1));
                                break;
                            }
                        }
                    }                   
                    // console.debug(`Service extended to ${dep.dest} from final stop ID ${result.run.final_stop_id} (using run ${dist.run_ref}) - now has ${dep.stations.length} stop(s)`);
                    result.run.final_stop_id = dep.stations[dep.stations.length - 1].id;
                }
            }
        }

        if (isCBDStation(result.run.final_stop_id)) {
            if (!cbdStation && result.run.final_stop_id != 1071) {
                /* last stop isn't Flinders Street */
                let idx = dep.stations.length - 1;
                while (idx >= 0) {
                    if (dep.stations[idx].id == 1071) break;
                    idx--;
                }
                if (idx >= 0) {
                    /* we've found Flinders Street */
                    dep.dest = result.stations[idx].name;
                    dep.stations = dep.stations.slice(0, idx + 1);
                }
            }

            if (dep.stations[dep.stations.length - 1] == 1071 && dep.stations[dep.stations.length - 2].id != 1181) {
                /* Flinders Street not preceded by Southern Cross - City Loop service */
                dep.dest = 'City Loop';
            }
        }

        let skippedStations = [], skipped = false, skippedLegs = 0;
        for (let i = 0; i < dep.stations.length; i++) {
            const stop = dep.stations[i];
            if (!skipped && stop.skipped) skippedLegs++;
            skipped = stop.skipped;
            if (skipped) skippedStations.push(stop);
        }
        if (!skippedLegs) dep.subtitle = 'Stops all';
        else if (skippedLegs > 1) dep.subtitle = 'Ltd express';
        else if (skippedStations.length == 1) dep.subtitle = (!result.note.length) ? `Not stopping at ${shortenName(skippedStations[0].name)}` : 'Ltd express'; // TODO
        else dep.subtitle = (skippedStations.length >= 4) ? 'Express' : 'Ltd express';
        dep.subtitle += ' ' + result.note;
        dep.subtitle = dep.subtitle.trim();
        dep.subtitle = dep.subtitle.charAt(0).toUpperCase() + dep.subtitle.slice(1);

        console.log(`${result.run.run_ref} ${dep.time} ${dep.dest} ${dep.subtitle}`);

        if (dep.dest.length > 14) dep.dest = shortenName(dep.dest);

        return dep;
    };

    const fetchDepartures = async () => {
        const resp = await axios.get(generateURL(`/departures/route_type/0/stop/${STATION}?expand=Run&expand=Route`)); // TODO: support V/Line only stations
        // fs.writeFileSync('depts.json', JSON.stringify(resp.data, 4));

        let deps = {}; // create new object
        
        /* preprocess route ID -> colour mappings */
        for (const [id, route] of Object.entries(resp.data.routes)) {
            // console.log(route);
            if (route.route_type != 0) routeColours.set(parseInt(id), 'vline');
            else if (!route.route_gtfs_id) routeColours.set(parseInt(id), 'special');
            else routeColours.set(parseInt(id), metroLines.get(route.route_gtfs_id.slice(2)) || 'special');
            // console.log(`Route ${id} (${route.route_name} ${route.route_gtfs_id}) -> ${routeColours.get(parseInt(id))}`);
        }
        // console.log(routeColours);

        /* process departures */
        const respRuns = resp.data.runs;
        const now = Date.now();
        let numDeps = 0;
        for (let dep of resp.data.departures) {
            const scheduledDeparture = new Date(dep.scheduled_departure_utc);
            if (scheduledDeparture.getTime() - now < -(60 * 1000)) continue; // ignore past departures
            if (!deps.hasOwnProperty(dep.platform_number)) deps[dep.platform_number] = []; // new platform
            const depData = {
                type: respRuns[dep.run_ref].route_type,
                run: dep.run_ref,
                time: scheduledDeparture,
                colour: routeColours.get(dep.route_id)
            };
            // console.log(depData);
            // let hr12 = depData.timeObj.getHours() % 12; if (hr12 == 0) hr12 = 12;
            // depData.time = `${hr12}:${depData.timeObj.getMinutes().toString().padStart(2, '0')}${(depData.timeObj.getHours() >= 12) ? 'pm' : 'am'}`;
            deps[dep.platform_number].push(depData);
            numDeps++;
        }
        console.log(`Retrieved ${numDeps} departure(s) on ${Object.keys(deps).length} platform(s)`);

        /* fetch up to 3 upcoming runs for each platform */
        const promises = [];
        for (const [pnum, platform] of Object.entries(deps)) {
            for (let i = 0; i < 3 && i < platform.length; i++) {
                // console.log(pnum, i, platform[i]);
                promises.push(fetchDepartureDetails(platform[i]).then((result) => { platform[i] = result; } ));
            }
        }
        await Promise.all(promises); // wait until all requests have completed
        console.log(`Fetched upcoming departure details`);

        departures = deps;
    };
    await fetchDepartures();
    cron.schedule('5 0 * * *', () => {
        fetchDepartures();
        appWs.getWss().clients.forEach((client) => client.send(JSON.stringify({ command: 'refresh' })));
    }); // cron job to get all departures for new day at 12am

    cron.schedule('*/1 * * * *', () => {
        const now = Date.now();

        const promises = []; // list of promises
        for (const [pnum, platform] of Object.entries(departures)) {
            /* check 1st service of each platform */
            if (platform.length == 0) continue; // no services

            const time = (platform[0].time - now) / 60000;
            // console.log(`Next service on platform ${pnum} (${platform.length} service(s) left): ${platform[0].run}, departing in ${Math.round(time)} min`);
            if (time <= -1) platform.shift(); // remove past service from list
            else if (time <= 0) { // fetch data for next service in preparation for removal
                if (platform.length > 1) {
                    const nextIdx = Math.min(platform.length - 1, 3);
                    if (!platform[nextIdx].hasOwnProperty('stations')) {
                        // console.log(`Fetching departure details for run ${platform[nextIdx].run}`);
                        promises.push(fetchDepartureDetails(platform[nextIdx]).then((result) => {
                            console.debug(`Fetched departure details for run ${result.run} on platform ${pnum}`);
                            platform[nextIdx] = result;
                            return {
                                platform: pnum,
                                service: result
                            };
                        }));
                    }
                }
            }
        }

        if (promises.length > 0) {
            Promise.all(promises).then((results) => {
                const platforms = results.reduce((obj, item) => Object.assign(obj, { [item.platform]: item.service }), {});
                // console.debug(platforms);
                appWs.getWss().clients.forEach((client) => {
                    // console.debug(client.pnum);
                    if (platforms.hasOwnProperty(client.pnum)) {
                        const service = platforms[client.pnum];
                        client.send(JSON.stringify({
                            command: 'append',
                            data: {
                                type: service.type,
                                run: service.run,
                                time: service.time.getTime(),
                                dest: service.dest,
                                subtitle: service.subtitle,
                                group: service.colour,
                                stations: service.stations
                            }
                        }));
                    }
                });
            });
        }
    });
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`App listening on port ${PORT}`);
    });
}
main();
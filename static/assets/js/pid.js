let PLATFORM = new URLSearchParams(window.location.search).get('num');

let pidData = [];

const printTime = (time, sec = false) => {
    time = new Date(time);
    let hr12 = time.getHours() % 12; if (hr12 == 0) hr12 = 12;
    let ampm = time.getHours() >= 12 ? 'pm' : 'am';
    let timeStr = hr12 + ':' + time.getMinutes().toString().padStart(2, '0');
    if (sec) timeStr += ':' + time.getSeconds().toString().padStart(2, '0');
    timeStr += ' ' + ampm;
    return timeStr;
};

const updateInfo = (data) => {
    data = data.filter((service) => service.time - Date.now() < (4 * 60 + 1) * 60 * 1000);
    if (data.length == 0) {
        document.getElementById('main').setAttribute('class', 'announcement');
        document.getElementById('announcement').innerText = 'No trains departing from this platform';        
        return;
    }
    
    document.getElementById('main').setAttribute('class', data[0].group);
    document.getElementById('time').innerText = data[0].timeText;
    document.getElementById('dest').innerText = data[0].dest;
    // document.getElementById('eta').innerText = data[0].eta;
    document.getElementById('subtitle').innerText = data[0].subtitle;

    const columns = [];
    const stations = data[0].stations;
    const rows = (stations.length > 28) ? 8 : 7;
    for (let col = 0; col < data[0].stations.length / rows && col < 4; col++) {
        columns.push('');
        for (let row = 0; row < rows && col * rows + row < stations.length; row++) {
            let i = col * rows + row;
            if (i == 4 * rows - 2 && stations.length > rows * 4) {
                columns[col] += `<li class='continue'><span>Continues to</span></li>`;
                columns[col] += `<li><span>${stations[stations.length - 1].name}</span></li>`;
                break;
            }
            columns[col] += `<li class='${stations[i].skipped ? 'skipped' : ''}'><span>${stations[i].name}</span></li>`;
        }
    }
    let stationsHTML = '';
    for (let col of columns) {
        stationsHTML += `<ul><div class="start"></div>${col}<div class="end"></div></ul>`;
    }
    document.getElementById('stations').innerHTML = stationsHTML;

    /* add information to next services panel */
    for (let i = 1; i <= 2; i++) {
        let ns = document.getElementById(`next-service-${i}`);
        if (data.length <= i) {
            /* no service */
            ns.setAttribute('class', 'next-service empty');
            document.getElementById(`ns${i}-time`).innerText = '';
            document.getElementById(`ns${i}-dest`).innerText = '--';
            document.getElementById(`ns${i}-eta`).innerText = '-- min';
            document.getElementById(`ns${i}-subtitle`).innerText = '--';
            continue;
        }

        ns.setAttribute('class', `next-service ${data[i].group}`);
        document.getElementById(`ns${i}-time`).innerText = data[i].timeText;
        document.getElementById(`ns${i}-dest`).innerText = data[i].dest;
        // document.getElementById(`ns${i}-eta`).innerText = data[i].eta;
        document.getElementById(`ns${i}-subtitle`).innerText = data[i].subtitle;
    }
};

const updateClock = async () => {
    const now = Date.now();
    document.getElementById('clock').innerText = printTime(now, true);

    let data = pidData.filter((service) => service.time - Date.now() < (4 * 60 + 1) * 60 * 1000);
    for (let i = 0; i < data.length && i < 3; i++) {
        let eta = (data[i].time - now) / 1000;
        if (eta <= -60) {
            document.getElementById('depart-bar').setAttribute('class', 'inactive');
            pidData.shift(); // remove past service
            if (pidData.length < 3) {
                try {
                    const service = (await axios.get(`departures/${PLATFORM}/after/${pidData[pidData.length - 1].run}`)).data;
                    service.timeText = printTime(service.time, false).replaceAll(' ', '');
                    pidData.push(service);
                } catch (err) {
                    console.error(err);
                }
            }
            updateInfo(pidData);
            updateClock();
            return;
        }
        if (eta <= 0) {
            let secs = Math.floor(-eta);
            eta = 'NOW';
            switch (secs) {
                case 15: // start departing bar
                    document.getElementById('depart-bar').setAttribute('class', '');
                    break;
                case 30: // fade out and show announcement (Stand Clear Train Departing)
                    document.getElementById('main').setAttribute('class', 'announcement');
                    document.getElementById('announcement').innerText = 'Stand Clear Train Departing';
                    break;
                default: break;
            }
        }
        else eta = Math.ceil(eta / 60) + ' min';
        document.getElementById(((i > 0) ? `ns${i}-` : '') + 'eta').innerText = eta;
    }
};

window.onload = () => {
    setInterval(updateClock, 1000);
    const fetchData = () => {
        axios.get(`departures/${PLATFORM}`).then((resp) => {
            pidData = resp.data;
        }).catch((err) => {
            if (err.status == 404) pidData = [];
            else throw err;
        }).finally(() => {
            for (const dep of pidData) dep.timeText = printTime(dep.time, false).replaceAll(' ', '');
            updateInfo(pidData);
            updateClock();
        });
    };
    // fetchData();

    const ws = new WebSocket(`ws/${PLATFORM}`);
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.command == 'append') {
            const servNew = data.data;
            for (let serv in pidData) {
                if (serv.type == servNew.type && serv.run == servNew.run) {
                    console.warn(`Received duplicated run ${servNew.type}/${servNew.run}`);
                    return;
                }
            }
            servNew.timeText = printTime(servNew.time, false).replaceAll(' ', '');
            pidData.push(servNew);
        } else if (data.command == 'refresh') {
            fetchData();
        }
    };
};

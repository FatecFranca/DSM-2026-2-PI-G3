'use strict';

import calcularDistancia from './Math.js';

/* ========================================
   CONFIGURAÇÃO
   ======================================== */
const config = {
    raioPadraoKm: 5,              // raio selecionado ao abrir a página
    raioMaximoKm: 15,             // raio máximo considerado; o filtro reduz na tela
    toleranciaKm: 0.15,           // distância máxima entre posto OSM e posto ANP
    tamanhoCelulaGrau: 0.005,     // ~500 m, tamanho das células do índice da ANP
    minCaracteresNome: 12,        // evita casar nomes genéricos como "POSTO"
    distanciaDuplicadoKm: 0.03,   // 30 m: pins próximos com nome igual são o mesmo posto
    minCaracteresBusca: 3,
    atrasoAutocompleteMs: 800,
     caminhoANP: './dados/json/postos_com_coordenadas.json',
     caminhoOsm: './dados/json/osm_BR.json',
    dataOsm: '2026-11-04',        // data em que o arquivo foi exportado do Overpass Turbo
    urlNominatim: 'https://nominatim.openstreetmap.org/search',
    urlTiles: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
};

/* ========================================
   ESTADO
   ======================================== */
let postosANP = [];
let gradeANP = new Map();
let elementosOsm = null;         // postos do OSM, lidos uma única vez
let prontoDados = null;          // promessa do carregamento da ANP e do OSM
let avisoFonte = '';             // aviso sobre a origem dos dados exibidos
let postosEncontrados = [];      // resultado da busca atual, já com distância e preço
let map = null;
let marcadorUsuario = null;
let localUsuario = null;
let timerAutocomplete = null;

/* ========================================
   UTILITÁRIOS
   ======================================== */
const $ = (id) => document.getElementById(id);

const setStatus = (mensagem) => { $('status').textContent = mensagem; };

const coordenadasValidas = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng);

const formatarDistancia = (km) => km < 1 ? `${Math.round(km * 1000)} metros` : `${km.toFixed(1)} km`;

const formatarPreco = (valor) => `R$ ${Number(valor).toFixed(2).replace('.', ',')}`;

const chaveCelula = (linha, coluna) => `${linha},${coluna}`;

/* ========================================
   BASE DE PREÇOS (ANP)
   ======================================== */
function linhaColuna(lat, lng) {
    return [
        Math.floor(lat / config.tamanhoCelulaGrau),
        Math.floor(lng / config.tamanhoCelulaGrau)
    ];
}

function criarGrade(postos) {
    const grade = new Map();

    for (const posto of postos) {
        if (!coordenadasValidas(posto.lat, posto.lng)) continue;

        const [linha, coluna] = linhaColuna(posto.lat, posto.lng);
        const chave = chaveCelula(linha, coluna);

        if (!grade.has(chave)) grade.set(chave, []);
        grade.get(chave).push(posto);
    }

    return grade;
}

async function carregarANP() {
    try {
        const res = await fetch(config.caminhoANP);
        if (!res.ok) throw new Error(`Status ${res.status}`);

        postosANP = await res.json();
        gradeANP = criarGrade(postosANP);
        preencherFiltros();
        console.info(`Preços carregados: ${postosANP.length} postos.`);
    } catch (erro) {
        console.warn('Não foi possível carregar os preços.', erro);
        postosANP = [];
        gradeANP = new Map();
    }
}

/* ========================================
   DADOS DO OPENSTREETMAP (ARQUIVO SALVO)
   ======================================== */
async function carregarOsm() {
    try {
        const res = await fetch(config.caminhoOsm);
        if (!res.ok) throw new Error(`Status ${res.status}`);

        elementosOsm = (await res.json()).elements;
        console.info(`Dados do OSM carregados: ${elementosOsm.length} elementos.`);
    } catch (erro) {
        console.warn('Não foi possível carregar o arquivo do OSM.', erro);
        elementosOsm = null;
    }
}

/* ========================================
   CRUZAMENTO OSM ↔ ANP
   ======================================== */
function normalizarNome(texto) {
    return String(texto ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')  // remove acentos
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, ' ')      // remove pontuação
        .replace(/\s+/g, ' ')
        .trim();
}

function nomesCombinam(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;

    // Contenção só por palavras inteiras e com nome suficientemente longo
    const [curto, longo] = a.length <= b.length ? [a, b] : [b, a];
    return curto.length >= config.minCaracteresNome &&
        ` ${longo} `.includes(` ${curto} `);
}

function encontrarPorDistancia(lat, lng) {
    const [linha, coluna] = linhaColuna(lat, lng);
    let melhor = null;
    let menorDistancia = Infinity;

    // Confere a célula do posto e as 8 vizinhas
    for (let dl = -1; dl <= 1; dl++) {
        for (let dc = -1; dc <= 1; dc++) {
            const candidatos = gradeANP.get(chaveCelula(linha + dl, coluna + dc)) ?? [];

            for (const posto of candidatos) {
                const distancia = calcularDistancia(lat, lng, posto.lat, posto.lng);

                if (distancia <= config.toleranciaKm && distancia < menorDistancia) {
                    menorDistancia = distancia;
                    melhor = posto;
                }
            }
        }
    }

    return melhor;
}

function encontrarPorNome(nomeOsm) {
    const alvo = normalizarNome(nomeOsm);
    if (!alvo) return null;

    return postosANP.find(function (posto) {
        return nomesCombinam(alvo, normalizarNome(posto.FANTASIA)) ||
            nomesCombinam(alvo, normalizarNome(posto['RAZÃO']));
    }) ?? null;
}

function encontrarPrecoANP(lat, lng, nomeOsm) {
    if (postosANP.length === 0 || !coordenadasValidas(lat, lng)) return null;

    return encontrarPorDistancia(lat, lng) ?? encontrarPorNome(nomeOsm);
}

/* ========================================
   NOMINATIM (transforma endereço em coordenada)
   ======================================== */
async function consultarNominatim(termo, limite) {
    const params = new URLSearchParams({
        format: 'json',
        limit: limite,
        countrycodes: 'br',
        q: termo
    });

    const res = await fetch(`${config.urlNominatim}?${params}`);
    if (!res.ok) throw new Error(`Status ${res.status}`);

    return res.json();
}

/* ========================================
   AUTOCOMPLETE
   ======================================== */
function limparSugestoes() {
    $('sugestoes').innerHTML = '';
}

function mostrarSugestoes(locais) {
    const caixa = $('sugestoes');
    caixa.innerHTML = '';

    for (const local of locais) {
        const item = document.createElement('div');
        item.className = 'sugestao-item';
        item.textContent = local.display_name;
        item.addEventListener('click', function () {
            escolherLocal(local);
        });
        caixa.appendChild(item);
    }
}

async function buscarSugestoes(termo) {
    try {
        mostrarSugestoes(await consultarNominatim(termo, 3));
    } catch (erro) {
        console.error('Erro no autocomplete:', erro);
    }
}

function aoDigitar(evento) {
    const texto = evento.target.value.trim();

    clearTimeout(timerAutocomplete);

    if (texto.length < config.minCaracteresBusca) {
        limparSugestoes();
        return;
    }

    timerAutocomplete = setTimeout(function () {
        buscarSugestoes(texto);
    }, config.atrasoAutocompleteMs);
}

function escolherLocal(local) {
    $('endereco').value = local.display_name;
    limparSugestoes();
    usarLocalizacao(parseFloat(local.lat), parseFloat(local.lon), 'Endereço selecionado!');
}

/* ========================================
   LOCALIZAÇÃO
   ======================================== */
async function usarLocalizacao(lat, lng, mensagem) {
    localUsuario = { lat, lng };
    setStatus(mensagem);
    criarMapa();
    await buscarPostos();
}

function obterLocalizacaoGPS() {
    const botao = $('btnLocalizacao');

    if (!navigator.geolocation) {
        setStatus('Seu navegador não suporta geolocalização.');
        return;
    }

    setStatus('Obtendo sua localização...');
    botao.disabled = true;

    navigator.geolocation.getCurrentPosition(
        async function ({ coords }) {
            try {
                await usarLocalizacao(coords.latitude, coords.longitude, 'Localização encontrada!');
            } finally {
                botao.disabled = false;
            }
        },
        function (erro) {
            console.error(erro);
            botao.disabled = false;
            setStatus('Erro ao obter localização.');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

async function buscarEndereco(texto) {
    const botao = $('btnEndereco');

    if (!texto) {
        setStatus('Digite um endereço.');
        return;
    }

    setStatus('Procurando endereço...');
    botao.disabled = true;

    try {
        const [local] = await consultarNominatim(texto, 1);

        if (!local) {
            setStatus('Endereço não encontrado.');
            return;
        }

        await usarLocalizacao(parseFloat(local.lat), parseFloat(local.lon), 'Endereço encontrado!');
    } catch (erro) {
        console.error(erro);
        setStatus('Erro ao procurar o endereço.');
    } finally {
        botao.disabled = false;
    }
}

/* ========================================
   MAPA
   ======================================== */
function criarMapa() {
    if (map) map.remove();
    postosEncontrados = [];

    map = L.map('map').setView([localUsuario.lat, localUsuario.lng], 14);

    L.tileLayer(config.urlTiles, {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    const iconeUsuario = L.divIcon({
        className: 'pin-usuario',
        html: '<span></span>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
        popupAnchor: [0, -12]
    });

    marcadorUsuario = L.marker([localUsuario.lat, localUsuario.lng], { icon: iconeUsuario }).addTo(map);
    marcadorUsuario.bindPopup('<strong>Você está aqui</strong>').openPopup();
}

// Remove os pins de postos, mantendo o marcador do usuário
function limparMarcadores() {
    if (!map) return;

    map.eachLayer(function (camada) {
        if (camada instanceof L.Marker && camada !== marcadorUsuario) {
            map.removeLayer(camada);
        }
    });
}

/* ========================================
   FILTROS
   ======================================== */
// Preenche os selects de bandeira e combustível com os valores da ANP
function preencherFiltros() {
    const bandeiras = [...new Set(postosANP.map(function (p) {
        return p.BANDEIRA;
    }).filter(Boolean))].sort();

    const combustiveis = [...new Set(postosANP.flatMap(function (p) {
        return (p.PRODUTOS ?? []).map(function (produto) {
            return produto.nome;
        });
    }))].sort();

    const selects = [
        ['selBandeira', bandeiras, 'Todas as bandeiras'],
        ['selCombustivel', combustiveis, 'Todos os combustíveis']
    ];

    for (const [id, valores, rotuloTodos] of selects) {
        const select = $(id);
        select.innerHTML = '';
        select.add(new Option(rotuloTodos, ''));

        for (const valor of valores) {
            select.add(new Option(valor, valor));
        }
    }

    $('selRaio').value = String(config.raioPadraoKm);
}

function precoDoCombustivel(posto, combustivel) {
    const produto = posto.dadosPreco?.PRODUTOS?.find(function (p) {
        return p.nome === combustivel;
    });
    return produto ? Number(produto.preco) : null;
}

function passaFiltros(posto) {
    const raioKm = Number($('selRaio').value);
    const bandeira = $('selBandeira').value;
    const combustivel = $('selCombustivel').value;
    const temAnp = Boolean(posto.dadosPreco);

    if (posto.distancia > raioKm) return false;

    if ($('chkApenasANP').checked && !temAnp) return false;

    if (bandeira && (!temAnp || posto.dadosPreco.BANDEIRA !== bandeira)) return false;

    if (combustivel && temAnp && precoDoCombustivel(posto, combustivel) === null) return false;

    return true;
}

// Ordena pelo preço do combustível; postos sem preço ficam no fim
function ordenarPorPreco(postos, combustivel) {
    return [...postos].sort(function (a, b) {
        const precoA = precoDoCombustivel(a, combustivel);
        const precoB = precoDoCombustivel(b, combustivel);

        if (precoA === null && precoB === null) return a.distancia - b.distancia;
        if (precoA === null) return 1;
        if (precoB === null) return -1;

        return precoA - precoB || a.distancia - b.distancia;
    });
}

function aplicarFiltros() {
    if (!localUsuario) return;

    const combustivel = $('selCombustivel').value;
    const ordenacao = $('selOrdenacao').value;
    const raioKm = Number($('selRaio').value);
    const container = $('postos');

    limparMarcadores();
    container.innerHTML = '';

    let lista = postosEncontrados.filter(passaFiltros);

    if (ordenacao === 'preco' && combustivel) {
        lista = ordenarPorPreco(lista, combustivel);
    }

    if (lista.length === 0) {
        container.innerHTML = '<p>Nenhum posto encontrado com esses filtros.</p>';
        setStatus('Nenhum posto encontrado com esses filtros.' + avisoFonte);
        return;
    }

    desenharPostos(lista, combustivel);

    let mensagem = `${lista.length} postos encontrados em até ${raioKm} km.`;

    if (combustivel) {
        const semPreco = lista.filter(function (p) {
            return precoDoCombustivel(p, combustivel) === null;
        }).length;

        if (semPreco > 0) {
            mensagem += ` ${semPreco} sem preço informado para ${combustivel}.`;
        }
    }

    if (ordenacao === 'preco' && !combustivel) {
        mensagem += ' Escolha um combustível para ordenar por preço.';
    }

    setStatus(mensagem + avisoFonte);
}

function desenharPostos(postos, combustivel) {
    for (const posto of postos) {
        adicionarMarcador(posto, combustivel);
        adicionarCard(posto, combustivel);
    }
}

// Mostra o valor do raio num balão que acompanha a posição do controle
function atualizarBalaoRaio() {
    const slider = $('selRaio');
    const min = Number(slider.min);
    const max = Number(slider.max);
    const valor = Number(slider.value);

    // Posição em porcentagem, com correção para a largura do controle (16 px)
    const percentual = (valor - min) / (max - min) * 100;
    const balao = $('balao-raio');

    balao.textContent = `${valor} km`;
    balao.style.left = `calc(${percentual}% + ${8 - percentual * 0.16}px)`;
}



/* ========================================
   BUSCA DE POSTOS (ARQUIVO SALVO)
   ======================================== */
async function buscarPostos() {
    setStatus('Procurando postos salvos...');

    await prontoDados;

    if (!elementosOsm) {
        postosEncontrados = [];
        avisoFonte = ' Arquivo de dados do OpenStreetMap não encontrado.';
        aplicarFiltros();
        return;
    }

    avisoFonte = ` Dados do OpenStreetMap de ${config.dataOsm} (arquivo salvo).`;
    postosEncontrados = processarElementos(elementosOsm);
    aplicarFiltros();
}

// Converte elementos do OSM em postos com distância e preço ANP.
function processarElementos(elementos) {
    const postos = [];

    for (const elemento of elementos) {
        const lat = elemento.type === 'node' ? elemento.lat : elemento.center?.lat;
        const lng = elemento.type === 'node' ? elemento.lon : elemento.center?.lon;

        if (!coordenadasValidas(lat, lng)) continue;

        const distancia = calcularDistancia(localUsuario.lat, localUsuario.lng, lat, lng);
        if (distancia > config.raioMaximoKm) continue;

        postos.push({
            ...elemento,
            lat,
            lng,
            distancia,
            dadosPreco: encontrarPrecoANP(lat, lng, elemento.tags?.name)
        });
    }

    postos.sort(function (a, b) {
        return a.distancia - b.distancia;
    });

    return removerDuplicados(postos);
}

// Remove pins muito próximos com o mesmo nome (ex.: node e way do mesmo posto no OSM)
function removerDuplicados(postos) {
    const mantidos = [];

    for (const posto of postos) {
        const nome = normalizarNome(nomeDoPosto(posto));

        const jaExiste = mantidos.some(function (outro) {
            return calcularDistancia(posto.lat, posto.lng, outro.lat, outro.lng) <= config.distanciaDuplicadoKm &&
                nomesCombinam(nome, normalizarNome(nomeDoPosto(outro)));
        });

        if (!jaExiste) mantidos.push(posto);
    }

    return mantidos;
}

/* ========================================
   INFORMAÇÕES DO POSTO
   ======================================== */
function nomeDoPosto(posto) {
    return posto.tags?.name
        || posto.dadosPreco?.FANTASIA
        || posto.dadosPreco?.['RAZÃO']
        || 'Posto de combustível';
}

function enderecoDoPosto(posto) {
    const p = posto.dadosPreco;

    if (p) {
        return `${p.ENDEREÇO || ''}, ${p.NÚMERO || ''} - ${p.BAIRRO || ''}, ${p.MUNICÍPIO || ''}`;
    }

    const tags = posto.tags || {};
    const partes = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city']].filter(Boolean);

    return partes.length > 0 ? partes.join(', ') : 'Endereço não informado';
}

// Nome da marca em minúsculas, para virar o data-marca do topo do card (ex.: "RAIZEN" -> "raizen")
function marcaDoPosto(posto) {
    return normalizarNome(posto.dadosPreco?.BANDEIRA).split(' ')[0].toLowerCase();
}

// Classe da bolinha de cada combustível (gasolina, etanol ou diesel)
function classeCombustivel(nome) {
    const n = normalizarNome(nome);

    if (n.includes('GASOLINA')) return 'gasolina';
    if (n.includes('ETANOL')) return 'etanol';
    if (n.includes('DIESEL')) return 'diesel';

    return '';
}

function htmlProdutos(posto, combustivel) {
    if (!posto.dadosPreco) {
        return '<p class="sem-preco">Preço não informado (sem dados da ANP)</p>';
    }

    const produtos = (posto.dadosPreco.PRODUTOS ?? [])
        .filter(function (p) {
            return !combustivel || p.nome === combustivel;
        });

    if (produtos.length === 0) {
        return '<p class="sem-preco">Preço não informado</p>';
    }

    const itens = produtos.map(function (p) {
        return `
        <li class="${classeCombustivel(p.nome)}">
            <span class="nome-combustivel">${p.nome.toLowerCase()}</span>
            <span class="preco">${formatarPreco(p.preco)}</span>
            <span class="data-coleta">${p.dt_coleta}</span>
        </li>`;
    }).join('');

    return `<ul class="lista-produtos">${itens}</ul>`;
}

/* ========================================
   MARCADOR E CARD
   ======================================== */
function adicionarMarcador(posto, combustivel) {
    let texto = '⛽';

    if (combustivel) {
        const preco = precoDoCombustivel(posto, combustivel);
        texto = preco === null ? 'Sem preço' : formatarPreco(preco);
    }

    const icone = L.divIcon({
        className: 'pin-preco',
        html: `<span>${texto}</span>`,
        iconSize: [72, 26],
        iconAnchor: [36, 26],
        popupAnchor: [0, -26]
    });

    L.marker([posto.lat, posto.lng], { icon: icone })
        .addTo(map)
        .bindPopup(`
            <div class="popup-posto">
                <strong>⛽ ${nomeDoPosto(posto)}</strong><br>
                ${enderecoDoPosto(posto)}<br><br>
                <strong>${formatarDistancia(posto.distancia)}</strong>
            </div>
        `);
}

function adicionarCard(posto, combustivel) {
    const urlMapas = `https://www.google.com/maps/search/?api=1&query=${posto.lat},${posto.lng}`;
    const bandeira = posto.dadosPreco?.BANDEIRA ?? 'Sem bandeira';

    const card = document.createElement('div');
    card.className = 'posto';
    card.innerHTML = `
        <div class="posto-topo" data-marca="${marcaDoPosto(posto)}">
            <span class="logo-marca">${bandeira}</span>
        </div>
        <div class="posto-cabecalho">
            <h3>${nomeDoPosto(posto)}</h3>
            <span class="distancia">${formatarDistancia(posto.distancia)}</span>
        </div>
        <p class="endereco">${enderecoDoPosto(posto)}</p>
        ${htmlProdutos(posto, combustivel)}
        <a href="${urlMapas}" target="_blank" rel="noopener noreferrer">
            Ver rota no Google Maps →
        </a>
    `;

    card.addEventListener('click', function () {
        map.setView([posto.lat, posto.lng], 17);
    });
    $('postos').appendChild(card);
}

/* ========================================
   INICIALIZAÇÃO
   ======================================== */
function registrarEventos() {
    $('selRaio').addEventListener('input', atualizarBalaoRaio);
    atualizarBalaoRaio();
    $('btnLocalizacao').addEventListener('click', obterLocalizacaoGPS);

    $('btnEndereco').addEventListener('click', function () {
        buscarEndereco($('endereco').value.trim());
    });

    $('endereco').addEventListener('input', aoDigitar);

    // Todos os filtros só reaplicam a lista; o checkbox "apenas ANP" é controlado pelo usuário
    for (const id of ['selRaio', 'selBandeira', 'selCombustivel', 'selOrdenacao', 'chkApenasANP']) {
        $(id).addEventListener('change', aplicarFiltros);
    }

    document.addEventListener('click', function (click) {
        if (!click.target.closest('.localizacao-manual')) limparSugestoes();
    });
}

registrarEventos();
prontoDados = Promise.all([carregarANP(), carregarOsm()]);

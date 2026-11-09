'use strict';

import calcularDistancia from './Math.js';

/* ========================================
   CONFIGURAÇÃO
   ======================================== */
const config = {
    raioMaximoKm: 15,             // raio máximo considerado; o filtro reduz na tela
    tamanhoCelulaGrau: 0.005,    // índice espacial da base ANP
    toleranciaNomeKm: 1,         // nome só pode confirmar um posto próximo
    toleranciaKm: 0.15,           // distância máxima entre posto OSM e posto ANP
    minCaracteresNome: 12,        // evita casar nomes genéricos como "POSTO"
    distanciaDuplicadoKm: 0.03,   // 30 m: pins próximos com nome igual são o mesmo posto
    minCaracteresBusca: 3,
    atrasoAutocompleteMs: 800,
    caminhoANP: './dados/json/postos_com_coordenadas.json',
    caminhoOsm: './dados/json/osm_BR.json',
    urlNominatim: 'https://nominatim.openstreetmap.org/search',
    urlTiles: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
};

/* ========================================
   ESTADO
   ======================================== */
let postosANP = [];
let gradeANP = new Map();
let bandeiras = {};
let erroANP = false;
let elementosOsm = null;         // postos do OSM, lidos uma única vez
let prontoDados = null;          // promessa do carregamento da ANP e do OSM
let avisoFonte = '';             // aviso sobre a origem dos dados exibidos
let postosEncontrados = [];      // resultado da busca atual, já com distância e preço
let map = null;
let marcadorUsuario = null;
let circuloBusca = null;
let localUsuario = null;
let timerAutocomplete = null;

/* ========================================
   UTILITÁRIOS
   ======================================== */
const $ = (id) => document.getElementById(id);

const setStatus = (mensagem) => { $('status').textContent = mensagem; };

const coordenadasValidas = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) < 90 && Math.abs(lng) <= 180;

const formatarDistancia = (km) => km < 1 ? `${Math.round(km * 1000)} metros` : `${km.toFixed(1)} km`;

const formatarPreco = (valor) => `R$ ${Number(valor).toFixed(2).replace('.', ',')}`;


/* ========================================
   BASE DE PREÇOS (ANP)
   ======================================== */
async function carregarLogos() {
    try {
        const resposta = await fetch('./dados/json/bandeiras.json');
        if (!resposta.ok) throw new Error('Falha ao carregar logos');
        bandeiras = await resposta.json();
    } catch (erro) {
        console.warn('Não foi possível carregar os logos.', erro);
    }
}

function logoBandeira(nome) {
    const chave = String(nome || 'SEM BANDEIRA').toUpperCase();
    const aliases = { SHELL: 'RAIZEN', BR: 'VIBRA', PETROBRAS: 'VIBRA' };
    const dados = bandeiras[aliases[chave] || chave];
    if (dados?.logo) return '<span class="logo-original" style="background:' + (dados.fundoLogo || '#fff') + '"><img src="' + dados.logo + '" alt="Logo da bandeira" loading="lazy"></span>';
    const rotulo = chave === 'BRANCA' ? 'Branca' : chave === 'SEM BANDEIRA' ? 'Sem bandeira' : nome;
    const classe = chave === 'SEM BANDEIRA' ? 'selo-sem-bandeira' : 'selo-bandeira';
    return '<span class="' + classe + '">' + escaparHTML(rotulo) + '</span>';
}

async function carregarANP() {
    try {
        const res = await fetch(config.caminhoANP);
        if (!res.ok) throw new Error(`Status ${res.status}`);

        postosANP = await res.json();
        gradeANP = criarGrade(postosANP);
        erroANP = false;
        console.info(`Preços carregados: ${postosANP.length} postos.`);
    } catch (erro) {
        console.warn('Não foi possível carregar os preços.', erro);
        postosANP = [];
        gradeANP = new Map();
        erroANP = true;
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
   NOMES DOS POSTOS
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

// A grade permite procurar apenas os registros ANP da vizinhança.
function linhaColuna(lat, lng) {
    return [Math.floor(lat / config.tamanhoCelulaGrau), Math.floor(lng / config.tamanhoCelulaGrau)];
}

function criarGrade(postos) {
    const grade = new Map();
    for (const posto of postos) {
        if (!coordenadasValidas(posto.lat, posto.lng)) continue;
        if (posto.precisao === 'municipio') continue;
        const chave = linhaColuna(posto.lat, posto.lng).join(',');
        if (!grade.has(chave)) grade.set(chave, []);
        grade.get(chave).push(posto);
    }
    return grade;
}

function candidatosProximos(lat, lng, raio) {
    const [linha, coluna] = linhaColuna(lat, lng);
    const tamanhoKm = config.tamanhoCelulaGrau * 111 * Math.cos(lat * Math.PI / 180);
    const alcance = Math.ceil(raio / tamanhoKm);
    const candidatos = [];
    for (let dl = -alcance; dl <= alcance; dl++) {
        for (let dc = -alcance; dc <= alcance; dc++) {
            for (const posto of gradeANP.get((linha + dl) + ',' + (coluna + dc)) || []) {
                if (calcularDistancia(lat, lng, posto.lat, posto.lng) <= raio) candidatos.push(posto);
            }
        }
    }
    return candidatos;
}

function bandeiraNormalizada(nome) {
    const marca = normalizarNome(nome);
    if (/SHELL|RAIZEN|SABBA/.test(marca)) return 'SHELL';
    if (['BR', 'PETROBRAS', 'VIBRA'].includes(marca)) return 'BR';
    return marca;
}

function identificacaoCompativel(posto, tags) {
    const cnpj = String(tags['ref:cnpj'] || '').replace(/\D/g, '');
    if (cnpj && cnpj.padStart(14, '0') !== String(posto.CNPJ).padStart(14, '0')) return false;
    if (tags.brand && posto.BANDEIRA && bandeiraNormalizada(tags.brand) !== bandeiraNormalizada(posto.BANDEIRA)) return false;
    return true;
}

function encontrarPorDistancia(lat, lng, tags = {}) {
    const candidatos = candidatosProximos(lat, lng, config.toleranciaKm)
        .filter(posto => identificacaoCompativel(posto, tags));
    // Não escolhe arbitrariamente entre dois estabelecimentos próximos.
    return candidatos.length === 1 ? candidatos[0] : null;
}

function encontrarPorNome(nomeOsm, lat, lng, tags = {}) {
    const nome = normalizarNome(nomeOsm);
    const palavras = nome.split(' ').filter(palavra => !['POSTO', 'AUTO', 'DE', 'DO', 'DA', 'COMBUSTIVEL', 'COMBUSTIVEIS'].includes(palavra));
    if (!palavras.length || ['SHELL', 'BR', 'IPIRANGA', 'ALE'].includes(bandeiraNormalizada(palavras.join(' ')))) return null;
    const candidatos = candidatosProximos(lat, lng, config.toleranciaNomeKm).filter(function (posto) {
        return identificacaoCompativel(posto, tags) && (
            nomesCombinam(nome, normalizarNome(posto.FANTASIA)) ||
            nomesCombinam(nome, normalizarNome(posto['RAZÃO']))
        );
    });
    return candidatos.length === 1 ? candidatos[0] : null;
}

function encontrarPrecoANP(lat, lng, nomeOsm, tags = {}) {
    if (!coordenadasValidas(lat, lng)) return null;
    return encontrarPorNome(nomeOsm, lat, lng, tags) || encontrarPorDistancia(lat, lng, tags);
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
    if (typeof L === 'undefined') { setStatus('Não foi possível carregar o mapa. Verifique sua conexão e recarregue a página.'); return; }
    if (map) map.remove();
    postosEncontrados = [];

    map = L.map('map', { zoomControl: false }).setView([localUsuario.lat, localUsuario.lng], 14);

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
    marcadorUsuario.bindPopup('<strong>Você está aqui</strong>');
    circuloBusca = L.circle([localUsuario.lat, localUsuario.lng], {
        radius: Number($('selRaio').value) * 1000,
        stroke: false,
        fillColor: '#92d945',
        fillOpacity: 0.23
    }).addTo(map);
    map.fitBounds(circuloBusca.getBounds(), { padding: [20, 20] });
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
// Mostra somente as bandeiras dos resultados, sem restringir pela bandeira escolhida.
function preencherFiltros() {
    const postos = postosEncontrados.filter(posto => passaFiltros(posto, true));
    const bandeiras = [...new Set(postos.map(posto => posto.dadosPreco?.BANDEIRA).filter(Boolean))].sort();
    const select = $('selBandeira');
    const escolhida = select.value;
    select.innerHTML = '';
    select.add(new Option('Todas as bandeiras', ''));
    for (const bandeira of bandeiras) {
        select.add(new Option(bandeira, bandeira));
    }
    select.value = bandeiras.includes(escolhida) ? escolhida : '';
    const opcoes = $('listaBandeiras');
    opcoes.innerHTML = '';
    for (const nome of ['', ...bandeiras]) {
        const botao = document.createElement('button');
        botao.type = 'button';
        botao.innerHTML = (nome ? '<span class="mini-bandeira">' + logoBandeira(nome) + '</span>' : '') + escaparHTML(nome || 'Todas as bandeiras');
        botao.addEventListener('click', function () {
            select.value = nome;
            $('menuBandeiras').open = false;
            aplicarFiltros();
        });
        opcoes.appendChild(botao);
    }
    $('bandeiraEscolhida').innerHTML = (select.value ? '<span class="mini-bandeira">' + logoBandeira(select.value) + '</span>' : '') + escaparHTML(select.value || 'Todas as bandeiras');
}

function precoDoCombustivel(posto, combustivel) {
    const produto = posto.dadosPreco?.PRODUTOS?.find(function (p) {
        return p.nome === combustivel || tipoCombustivel(p.nome) === combustivel;
    });
    return produto ? Number(produto.preco) : null;
}

function passaFiltros(posto, ignorarBandeira = false) {
    const raioKm = Number($('selRaio').value);
    const bandeira = $('selBandeira').value;
    const temAnp = Boolean(posto.dadosPreco);

    if (posto.distancia > raioKm) return false;
    const selecionados = [...document.querySelectorAll('[data-fuel]:checked')].map(input => input.dataset.fuel);
    if (!selecionados.length) return false;
    if (temAnp && !posto.dadosPreco.PRODUTOS.some(p => selecionados.includes(tipoCombustivel(p.nome)))) return false;

    if ($('chkApenasANP').checked && !temAnp) return false;

    if (!ignorarBandeira && bandeira && (!temAnp || posto.dadosPreco.BANDEIRA !== bandeira)) return false;


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

    const selecionados = document.querySelectorAll('[data-fuel]:checked');
    $('avisoMapa').textContent = selecionados.length === 1
        ? 'Preço no mapa: ' + selecionados[0].dataset.fuel.replace(/-/g, ' ') + '.'
        : 'Para ver preços no mapa, marque apenas um combustível.';

    const combustivel = selecionados.length === 1 ? selecionados[0].dataset.fuel : '';
    const ordenacao = $('selOrdenacao').value;
    const raioKm = Number($('selRaio').value);
    const container = $('postos');

    limparMarcadores();
    container.innerHTML = '';

    preencherFiltros();
    let lista = postosEncontrados.filter(posto => passaFiltros(posto));

    if (ordenacao === 'preco' && combustivel) {
        lista = ordenarPorPreco(lista, combustivel);
    }

    if (lista.length === 0) {
        const mensagem = selecionados.length === 0
            ? 'Selecione um combustível para ver os postos e preços.'
            : 'Nenhum posto encontrado com esses filtros.';
        container.innerHTML = '<p>' + mensagem + '</p>';
        setStatus(mensagem + avisoFonte);
        return;
    }

    // Os postos com preços aparecem primeiro; a distância ordena cada grupo.
    if (ordenacao !== 'preco') {
        lista.sort(function (a, b) {
            return Number(Boolean(b.dadosPreco)) - Number(Boolean(a.dadosPreco)) || a.distancia - b.distancia;
        });
    }
    desenharPostos(lista, combustivel);

    const comPreco = lista.filter(posto => posto.dadosPreco).length;
    let mensagem = `${lista.length} postos encontrados em até ${raioKm} km. ${comPreco} com preços da ANP.`;

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
    if (circuloBusca) circuloBusca.setRadius(valor * 1000);
    slider.style.setProperty('--progress', `${percentual}%`);
}



/* ========================================
   BUSCA DE POSTOS (ARQUIVO SALVO)
   ======================================== */
async function buscarPostos() {
    setStatus('Carregando os preços da ANP...');
    await prontoDados;

    postosEncontrados = processarElementos(elementosOsm || []);
    avisoFonte = ' Localização: postos cadastrados no OSM. Preços: ANP, quando a associação é possível.';
    if (erroANP) avisoFonte += ' Não foi possível carregar a base de preços da ANP.';
    if (!elementosOsm) avisoFonte = ' OSM indisponível: não foi possível confirmar a localização dos postos. Recarregue a página.';
    aplicarFiltros();
}

function processarElementos(elementos) {
    const postos = [];
    for (const elemento of elementos) {
        if (elemento.tags?.amenity !== 'fuel') continue;
        if (elemento.tags.disused === 'yes' || elemento.tags.abandoned === 'yes') continue;
        if (elemento.tags['disused:amenity'] || elemento.tags['abandoned:amenity']) continue;
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
            dadosPreco: encontrarPrecoANP(lat, lng, elemento.tags.name, elemento.tags)
        });
    }
    postos.sort((a, b) => a.distancia - b.distancia);
    const lista = removerDuplicados(postos);
    const associados = new Map();
    for (const posto of lista) {
        if (!posto.dadosPreco) continue;
        const dados = posto.dadosPreco;
        const anterior = associados.get(dados);
        if (!anterior) {
            associados.set(dados, posto);
            continue;
        }
        // Um registro ANP não fornece preço para dois postos OSM diferentes.
        const distanciaAtual = calcularDistancia(posto.lat, posto.lng, dados.lat, dados.lng);
        const distanciaAnterior = calcularDistancia(anterior.lat, anterior.lng, dados.lat, dados.lng);
        if (distanciaAtual < distanciaAnterior) {
            anterior.dadosPreco = null;
            associados.set(dados, posto);
        } else {
            posto.dadosPreco = null;
        }
    }
    return lista;
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
    const marca = normalizarNome(posto.dadosPreco?.BANDEIRA || posto.tags?.brand).toLowerCase();
    if (marca === 'branca') return 'branca';
    if (!marca) return 'sem-bandeira';
    if (/shell|raizen/.test(marca)) return 'shell';
    if (/vibra|petrobras|br distrib/.test(marca)) return 'petrobras';
    if (/ipiranga/.test(marca)) return 'ipiranga';
    if (/ale/.test(marca)) return 'ale';
    return 'outra';
}

// Classe da bolinha de cada combustível (gasolina, etanol ou diesel)
function classeCombustivel(nome) {
    const n = normalizarNome(nome);

    if (n.includes('GASOLINA')) return 'gasolina';
    if (n.includes('ETANOL')) return 'etanol';
    if (n.includes('DIESEL')) return 'diesel';

    return '';
}

// Separa as variações sem mudar as cores dos combustíveis.
function tipoCombustivel(nome) {
    const n = normalizarNome(nome);
    if (n.includes('GASOLINA') && n.includes('ADITIVADA')) return 'gasolina-aditivada';
    if (n.includes('DIESEL') && /S\s*10\b/.test(n)) return 'diesel-s10';
    if (n.includes('DIESEL') && /S\s*500\b/.test(n)) return 'diesel-s500';
    return classeCombustivel(nome);
}

function htmlProdutos(posto, combustivel) {
    if (!posto.dadosPreco) {
        return '<p class="sem-preco">Preço da ANP não associado a este posto.</p>';
    }

    const produtos = (posto.dadosPreco.PRODUTOS ?? [])
        .filter(function (p) {
            const ativo = document.querySelector(`[data-fuel="${tipoCombustivel(p.nome)}"]`);
            return (!combustivel || p.nome === combustivel || tipoCombustivel(p.nome) === combustivel) && (!ativo || ativo.checked);
        });

    if (produtos.length === 0) {
        return '<p class="sem-preco">Preço não informado</p>';
    }

    const itens = produtos.map(function (p) {
        return `
        <li class="${classeCombustivel(p.nome)}">
            <span class="nome-combustivel">${escaparHTML(p.nome.toLowerCase())}</span>
            <span class="preco">${formatarPreco(p.preco)}</span>
            <span class="data-coleta">Coleta: ${escaparHTML(p.dt_coleta)}</span>
        </li>`;
    }).join('');

    return `<ul class="lista-produtos">${itens}</ul>`;
}

/* ========================================
   MARCADOR E CARD
   ======================================== */
// Mostra um único preço somente quando o filtro identifica um combustível.
function produtoNoMapa(posto, combustivel) {
    const selecionados = document.querySelectorAll('[data-fuel]:checked');
    if (!combustivel && selecionados.length !== 1) return null;

    const produtos = (posto.dadosPreco?.PRODUTOS || []).filter(function (produto) {
        if (combustivel) return produto.nome === combustivel || tipoCombustivel(produto.nome) === combustivel;
        return tipoCombustivel(produto.nome) === selecionados[0].dataset.fuel;
    });

    // Prefere gasolina comum e diesel S10 quando existem variações na base.
    return produtos.find(function (produto) {
        return produto.nome === 'GASOLINA COMUM' || produto.nome === 'DIESEL S10';
    }) || produtos[0];
}

function adicionarMarcador(posto, combustivel) {
    if (!map) return;
    const produto = produtoNoMapa(posto, combustivel);

    const icone = L.divIcon({
        className: 'pin-preco',
        html: '<span></span>',
        iconSize: [17, 23],
        iconAnchor: [8, 23],
        popupAnchor: [0, -26]
    });

    const marcador = L.marker([posto.lat, posto.lng], {
        icon: icone,
        title: produto ? produto.nome + ': ' + formatarPreco(produto.preco) + ' — coleta: ' + produto.dt_coleta : nomeDoPosto(posto)
    })
        .addTo(map)
        .bindPopup(`
            <div class="popup-posto">
                <strong>⛽ ${escaparHTML(nomeDoPosto(posto))}</strong><br>
                ${escaparHTML(enderecoDoPosto(posto))}<br><br>
                <strong>${formatarDistancia(posto.distancia)}</strong>
            </div>
        `);

    if (produto) {
        marcador.bindTooltip(formatarPreco(produto.preco), {
            permanent: true,
            direction: 'right',
            offset: [4, -12],
            className: 'preco-mapa',
            opacity: 1
        });
    }
}

function adicionarCard(posto, combustivel) {
    const urlMapas = `https://www.google.com/maps/search/?api=1&query=${posto.lat},${posto.lng}`;
    const bandeira = posto.dadosPreco?.BANDEIRA || posto.tags?.brand || 'Sem bandeira';
    const marca = marcaDoPosto(posto);
    const logo = logoBandeira(bandeira);

    const card = document.createElement('div');
    card.className = 'posto';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Ver ${nomeDoPosto(posto)} no mapa`);
    card.addEventListener('keydown', function (evento) {
        if (evento.key === 'Enter' || evento.key === ' ') {
            evento.preventDefault();
            card.click();
        }
    });
    card.innerHTML = `
        <div class="posto-topo" data-marca="${marca}">
            <span class="logo-marca">${logo}</span>
        </div>
        <div class="posto-cabecalho">
            <h3>${escaparHTML(nomeDoPosto(posto))}</h3>
            <span class="distancia">${formatarDistancia(posto.distancia)}</span>
        </div>
        <p class="endereco">${escaparHTML(enderecoDoPosto(posto))}</p>
        ${htmlProdutos(posto, combustivel)}
        <a href="${urlMapas}" target="_blank" rel="noopener noreferrer">
            Ver rota no Google Maps →
        </a>
    `;

    card.addEventListener('click', function () {
        if (map) map.setView([posto.lat, posto.lng], 17);
    });
    $('postos').appendChild(card);
}

/* ========================================
   INICIALIZAÇÃO
   ======================================== */
function registrarEventos() {
    $('selRaio').addEventListener('input', atualizarBalaoRaio);
    $('selRaio').addEventListener('change', function () {
        if (map && circuloBusca) {
            map.fitBounds(circuloBusca.getBounds(), { padding: [20, 20] });
        }
    });
    atualizarBalaoRaio();
    $('btnLocalizacao').addEventListener('click', obterLocalizacaoGPS);

    $('btnEndereco').addEventListener('click', function () {
        buscarEndereco($('endereco').value.trim());
    });

    $('endereco').addEventListener('input', aoDigitar);

    // Todos os filtros só reaplicam a lista; o checkbox "apenas ANP" é controlado pelo usuário
    for (const id of ['selRaio', 'selBandeira', 'selOrdenacao', 'chkApenasANP']) {
        $(id).addEventListener('change', aplicarFiltros);
    }

    document.addEventListener('click', function (click) {
        if (!click.target.closest('.localizacao-manual')) limparSugestoes();
    });
}

registrarEventos();
prontoDados = Promise.all([carregarANP(), carregarOsm(), carregarLogos()]);
// Converte texto para HTML sem interpretar tags vindas dos dados.
function escaparHTML(valor) {
    const texto = document.createElement('span');
    texto.textContent = valor ?? '';
    return texto.innerHTML;
}

$('toggleFiltros').addEventListener('click', () => {
    const recolhido = $('app').classList.toggle('collapsed');
    $('toggleFiltros').textContent = recolhido ? '›' : '‹';
    $('toggleFiltros').setAttribute('aria-expanded', String(!recolhido));
    $('toggleFiltros').setAttribute('aria-label', recolhido ? 'Expandir filtros' : 'Recolher filtros');
    if (map) map.invalidateSize();
});
document.querySelectorAll('[data-fuel]').forEach(input => input.addEventListener('change', aplicarFiltros));
$('endereco').addEventListener('keydown', function (evento) {
    if (evento.key === 'Enter') {
        evento.preventDefault();
        $('btnEndereco').click();
    }
});
$('welcomeRaio').addEventListener('input', () => { $('welcomeOutput').textContent = $('welcomeRaio').value + ' km'; });
$('welcomeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const endereco = $('welcomeEndereco').value.trim();
    if (!endereco) {
        $('welcomeError').textContent = 'Digite um endereço para buscar.';
        $('welcomeEndereco').focus();
        return;
    }
    $('endereco').value = endereco;
    $('selRaio').value = $('welcomeRaio').value;
    atualizarBalaoRaio();
    const tipo = $('welcomeCombustivel').value;
    document.querySelectorAll('[data-fuel]').forEach(input => { input.checked = input.dataset.fuel === tipo; });
    $('welcome').close();
    await buscarEndereco(endereco);
});
const textosInfo = {
    sobre: ['Sobre o PI', 'O EncontraA! é um projeto acadêmico do grupo 3 para localizar postos de combustível e comparar os preços disponíveis na base da ANP. Os valores e a disponibilidade podem mudar; confirme com o estabelecimento.'],
    dicas: ['Dicas para abastecer', 'Compare os preços e a distância antes de escolher um posto. Para comparar etanol e gasolina, considere o consumo real do seu veículo. Confira a data de coleta dos dados antes de abastecer.'],
    perfil: ['Perfil', 'A busca está disponível sem cadastro. O projeto ainda não possui autenticação de usuários.']
};
document.querySelectorAll('[data-info]').forEach(button => button.addEventListener('click', () => {
    const [titulo, texto] = textosInfo[button.dataset.info];
    $('infoTitle').textContent = titulo; $('infoText').textContent = texto; $('infoDialog').showModal();
}));
$('closeInfo').addEventListener('click', () => $('infoDialog').close());
$('navPostos').addEventListener('click', e => { e.preventDefault(); document.querySelector('.conteudo').scrollIntoView({ behavior: 'smooth' }); });
// Local inicial do mapa; a busca permite escolher qualquer outro endereço.
usarLocalizacao(-20.5216968, -47.4095364, 'Carregando postos de Franca...');
$('welcome').showModal();

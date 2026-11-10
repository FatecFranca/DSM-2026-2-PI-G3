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
    caminhoBandeiras: './dados/json/bandeiras.json',
    urlNominatim: 'https://nominatim.openstreetmap.org/search',
    urlTiles: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    aliasesBandeiras: { SHELL: 'RAIZEN', BR: 'VIBRA', PETROBRAS: 'VIBRA' },
    textosInfo: {
        perfil: ['Perfil', 'A busca está disponível sem cadastro. O projeto ainda não possui autenticação de usuários.']
    }
};

/* ========================================
   ESTADO
   ======================================== */
let postosANP = [];
let gradeANP = new Map();
let bandeirasLogo = {};          // logos carregados de bandeiras.json
let erroANP = false;             // true quando a base da ANP não carrega
let dataColetaANP = '';          // data de coleta mais recente dos preços da ANP
let elementosOsm = null;         // postos do OSM, lidos uma única vez
let prontoDados = null;          // promessa do carregamento da ANP, do OSM e dos logos
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

const coordenadasValidas = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng);

const chaveCelula = (linha, coluna) => `${linha},${coluna}`;

const formatarDistancia = (km) => km < 1 ? `${Math.round(km * 1000)} metros` : `${km.toFixed(1)} km`;

const formatarPreco = (valor) => `R$ ${Number(valor).toFixed(2).replace('.', ',')}`;

// Primeira letra maiúscula e o restante minúsculo (ex.: "AVENIDA BRASIL" -> "Avenida brasil")
const capitalizarTexto = (texto) => {
    const limpo = String(texto ?? '').trim().toLowerCase();
    return limpo.charAt(0).toUpperCase() + limpo.slice(1);
};

const ESCAPES_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escapa dados externos (ANP, OpenStreetMap, bandeiras) antes de inserir no HTML
const escaparHtml = (valor) => String(valor ?? '').replace(/[&<>"']/g, (c) => ESCAPES_HTML[c]);

// Abre o diálogo; se o navegador não tiver showModal, usa o atributo open
function abrirDialog(dialog) {
    if (typeof dialog.showModal === 'function') {
        dialog.showModal();
    } else {
        dialog.setAttribute('open', '');
    }
}

function fecharDialog(dialog) {
    if (typeof dialog.close === 'function') {
        dialog.close();
    } else {
        dialog.removeAttribute('open');
    }
}

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

// Procura a data de coleta mais recente entre todos os produtos (formato dd-mm-aaaa)
function dataColetaMaisRecente() {
    let maisRecente = null;

    for (const posto of postosANP) {
        for (const produto of posto.PRODUTOS ?? []) {
            const [dia, mes, ano] = String(produto.dt_coleta ?? '').split('-').map(Number);
            if (!dia || !mes || !ano) continue;

            const data = new Date(ano, mes - 1, dia);
            if (!maisRecente || data > maisRecente) maisRecente = data;
        }
    }

    return maisRecente ? maisRecente.toLocaleDateString('pt-BR') : '';
}

async function carregarANP() {
    try {
        const res = await fetch(config.caminhoANP);
        if (!res.ok) throw new Error(`Status ${res.status}`);

        postosANP = await res.json();
        gradeANP = criarGrade(postosANP);
        dataColetaANP = dataColetaMaisRecente();
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
   LOGOS DAS BANDEIRAS
   ======================================== */
async function carregarLogos() {
    try {
        const res = await fetch(config.caminhoBandeiras);
        if (!res.ok) throw new Error(`Status ${res.status}`);

        bandeirasLogo = await res.json();
    } catch (erro) {
        console.warn('Não foi possível carregar os logos.', erro);
        bandeirasLogo = {};
    }
}

// Cor do topo do card, vinda do bandeiras.json
function fundoTopoDoPosto(posto) {
    const chave = normalizarNome(bandeiraDoPosto(posto) || 'SEM BANDEIRA');
    const chaveReal = config.aliasesBandeiras[chave] || chave;

    return bandeirasLogo[chaveReal]?.fundoTopo || '#b1b1b1';
}

// Identificador único da bandeira: aplica os aliases (SHELL -> RAIZEN, BR -> VIBRA)
function chaveBandeira(nome) {
    const chave = normalizarNome(nome || 'SEM BANDEIRA');
    return config.aliasesBandeiras[chave] || chave;
}

function logoBandeira(nome) {
    const chave = normalizarNome(nome || 'SEM BANDEIRA');
    const chaveReal = config.aliasesBandeiras[chave] || chave;
    const dados = bandeirasLogo[chaveReal];

    if (dados?.logo) {
        const fundo = dados.fundoLogo ? ` style="background:${escaparHtml(dados.fundoLogo)}"` : '';
        return `<span class="logo-original"${fundo}><img src="${escaparHtml(dados.logo)}" alt="Logo ${escaparHtml(capitalizarTexto(nome))}" loading="lazy"></span>`;
    }

    const classe = chave === 'SEM BANDEIRA' ? 'selo-sem-bandeira' : 'selo-bandeira';
    const rotulo = chave === 'SEM BANDEIRA' ? 'Sem bandeira' : nome;

    return `<span class="${classe}">${escaparHtml(capitalizarTexto(rotulo))}</span>`;
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

    // O mapa só é criado quando o usuário define o local
    if (!criarMapa()) return;

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
    if (typeof L === 'undefined') {
        setStatus('Não foi possível carregar o mapa. Verifique sua conexão e recarregue a página.');
        return false;
    }

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

    // Renderizador com margem: desenha o círculo também fora da área visível,
    // para que ele não suma enquanto o mapa é arrastado
    const renderizador = L.svg({ padding: 1 });

    circuloBusca = L.circle([localUsuario.lat, localUsuario.lng], {
        radius: Number($('selRaio').value) * 1000,
        stroke: false,
        fillColor: '#92d945',
        fillOpacity: 0.23,
        renderer: renderizador
    }).addTo(map);

    map.fitBounds(circuloBusca.getBounds(), { padding: [20, 20] });
    return true;
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
// Combustíveis marcados nas checkboxes ([data-fuel])
function combustiveisSelecionados() {
    return [...document.querySelectorAll('[data-fuel]:checked')].map(input => input.dataset.fuel);
}

function combustiveisEfetivos() {
    const selecionados = combustiveisSelecionados();
    if (selecionados.length > 0) return selecionados;

    return [...document.querySelectorAll('[data-fuel]')].map(input => input.dataset.fuel);
}

function precoDoCombustivel(posto, combustivel) {
    const produto = posto.dadosPreco?.PRODUTOS?.find(function (p) {
        return p.nome === combustivel || tipoCombustivel(p.nome) === combustivel;
    });
    return produto ? Number(produto.preco) : null;
}

// Decide se o posto aparece com os filtros atuais.
// ignorarBandeira é usado para montar a lista de bandeiras sem restringir por elas.
function passaFiltros(posto, ignorarBandeira = false) {
    const raioKm = Number($('selRaio').value);
    const bandeira = $('selBandeira').value;
    const selecionados = combustiveisSelecionados();
    const temAnp = Boolean(posto.dadosPreco);

    if (posto.distancia > raioKm) return false;

    if (temAnp && !(posto.dadosPreco.PRODUTOS ?? []).some(p => selecionados.includes(tipoCombustivel(p.nome)))) return false;

    if ($('chkApenasANP').checked && !temAnp) return false;

    if (!ignorarBandeira && bandeira && chaveBandeira(bandeiraDoPosto(posto)) !== chaveBandeira(bandeira)) return false;

    return true;
}

// Ordena pelo preço do combustível; postos sem preço ficam no fim, ordenados por distância
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

function atualizarBandeiras() {
    const postos = postosEncontrados.filter(p =>
    p.distancia <= Number($('selRaio').value) &&
    (!$('chkApenasANP').checked || p.dadosPreco)
    );

    // Uma opção por bandeira real: SHELL e RAIZEN contam como a mesma
    const porChave = new Map();

    for (const posto of postos) {
        const nome = bandeiraDoPosto(posto);
        if (!nome) continue;

        const chave = chaveBandeira(nome);
        if (!porChave.has(chave)) porChave.set(chave, nome);
    }

    const bandeiras = [...porChave.values()].sort();
    const select = $('selBandeira');
    const escolhida = select.value;

    select.innerHTML = '';
    select.add(new Option('Todas as bandeiras', ''));

    for (const bandeira of bandeiras) {
        select.add(new Option(bandeira, bandeira));
    }

    select.value = bandeiras.includes(escolhida) ? escolhida : '';

    const lista = $('listaBandeiras');
    lista.innerHTML = '';

    for (const nome of ['', ...bandeiras]) {
        const botao = document.createElement('button');
        botao.type = 'button';
        botao.innerHTML = (nome ? `<span class="mini-bandeira">${logoBandeira(nome)}</span>` : '') +
            escaparHtml(nome ? capitalizarTexto(nome) : 'Todas as bandeiras');

        botao.addEventListener('click', function () {
            select.value = nome;
            $('menuBandeiras').open = false;
            aplicarFiltros();
        });

        lista.appendChild(botao);
    }
}

// Atualiza só o texto do menu de bandeiras (não reconstrói a lista)
function atualizarRotuloBandeira() {
    const bandeira = $('selBandeira').value;

    $('bandeiraEscolhida').innerHTML = bandeira
        ? `<span class="mini-bandeira">${logoBandeira(bandeira)}</span>${escaparHtml(capitalizarTexto(bandeira))}`
        : 'Todas as bandeiras';
}

function atualizarAvisoMapa(combustiveis) {
    $('avisoMapa').textContent = combustiveis.length === 1
        ? `Preço no mapa: ${capitalizarTexto(combustiveis[0].replace(/-/g, ' '))}.`
        : 'Para ver preços no mapa, marque apenas um combustível.';
}

// Aplica os filtros sobre a busca atual, sem nova consulta
function aplicarFiltros() {
    if (!localUsuario) return;

    const combustiveis = combustiveisSelecionados();
    const combustivel = combustiveis.length === 1 ? combustiveis[0] : '';
    const ordenacao = $('selOrdenacao').value;
    const raioKm = Number($('selRaio').value);
    const container = $('postos');

    atualizarAvisoMapa(combustiveis);
    atualizarRotuloBandeira();
    limparMarcadores();
    container.innerHTML = '';

    let lista = postosEncontrados.filter(posto => passaFiltros(posto));

    if (ordenacao === 'preco' && combustivel) {
        lista = ordenarPorPreco(lista, combustivel);
    }

    if (lista.length === 0) {
        const mensagem = combustiveis.length === 0
            ? 'Selecione um combustível para ver os postos e preços.'
            : 'Nenhum posto encontrado com esses filtros.';

        container.innerHTML = `<p>${mensagem}</p>`;
        setStatus(mensagem + avisoFonte);
        return;
    }

    desenharPostos(lista, combustivel);

    const comPreco = lista.filter(posto => posto.dadosPreco).length;
    let mensagem = `${lista.length} postos encontrados em até ${raioKm} km. ${comPreco} com preços da ANP.`;

    if (combustivel) {
        const semPreco = lista.filter(function (p) {
            return precoDoCombustivel(p, combustivel) === null;
        }).length;

        if (semPreco > 0) {
            mensagem += ` ${semPreco} sem preço informado para ${capitalizarTexto(combustivel.replace(/-/g, ' '))}.`;
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

// Mostra o valor do raio num balão, move o preenchimento do slider e atualiza o círculo
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
    slider.style.setProperty('--progress', `${percentual}%`);

    if (circuloBusca) circuloBusca.setRadius(valor * 1000);
}

/* ========================================
   BUSCA DE POSTOS (ARQUIVO SALVO)
   ======================================== */
async function buscarPostos() {
    setStatus('Carregando os preços da ANP...');
    await prontoDados;

    if (!elementosOsm) {
        postosEncontrados = [];
        avisoFonte = ' OSM indisponível: não foi possível confirmar a localização dos postos. Recarregue a página.';
        atualizarBandeiras();
        aplicarFiltros();
        return;
    }

    postosEncontrados = processarElementos(elementosOsm);
    avisoFonte = montarAviso();
    atualizarBandeiras();
    aplicarFiltros();
}

// Texto do status com a origem dos dados e a data de coleta da ANP
function montarAviso() {
    let aviso = ' Localização: postos do OpenStreetMap. Preços: ANP';

    if (dataColetaANP) aviso += `, coletados em ${dataColetaANP}`;
    aviso += '.';

    if (erroANP) aviso += ' Não foi possível carregar a base de preços da ANP.';

    return aviso;
}

// Converte elementos do OSM em postos com distância e preço ANP
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

    // Ordenação padrão: sempre pela distância
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
    const nome = posto.tags?.name
        || posto.dadosPreco?.FANTASIA
        || posto.dadosPreco?.['RAZÃO']
        || 'Posto de combustível';

    return capitalizarTexto(nome);
}

function enderecoDoPosto(posto) {
    const p = posto.dadosPreco;

    if (p) {
        return capitalizarTexto(`${p.ENDEREÇO || ''}, ${p.NÚMERO || ''} - ${p.BAIRRO || ''}, ${p.MUNICÍPIO || ''}`);
    }

    const tags = posto.tags || {};
    const partes = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city']].filter(Boolean);

    return partes.length > 0 ? capitalizarTexto(partes.join(', ')) : 'Endereço não informado';
}

// Valor do data-marca do topo do card; os nomes batem com o CSS
function marcaDoPosto(posto) {
    const marca = normalizarNome(bandeiraDoPosto(posto));

    if (!marca) return 'sem-bandeira';
    if (/SHELL|RAIZEN/.test(marca)) return 'raizen';
    if (/VIBRA|PETROBRAS|^BR$/.test(marca)) return 'vibra';
    if (/IPIRANGA/.test(marca)) return 'ipiranga';
    if (/\bALE\b/.test(marca)) return 'ale';

    return 'outra';
}

function bandeiraDoPosto(posto) {
    return posto.dadosPreco?.BANDEIRA || posto.tags?.brand || '';
}

// Classe da bolinha de cada combustível (gasolina, etanol ou diesel)
function classeCombustivel(nome) {
    const n = normalizarNome(nome);

    if (n.includes('GASOLINA')) return 'gasolina';
    if (n.includes('ETANOL')) return 'etanol';
    if (n.includes('DIESEL')) return 'diesel';

    return '';
}

// Separa as variações sem mudar as cores dos combustíveis
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

    const selecionados = combustiveisEfetivos();
    const tiposDisponiveis = [...document.querySelectorAll('[data-fuel]')].map(input => input.dataset.fuel);

    const produtos = (posto.dadosPreco.PRODUTOS ?? []).filter(function (p) {
        const tipo = tipoCombustivel(p.nome);
        return !tiposDisponiveis.includes(tipo) || selecionados.includes(tipo);
    });

    if (produtos.length === 0) {
        return '<p class="sem-preco">Preço não informado</p>';
    }

    const itens = produtos.map(function (p) {
        return `
        <li class="${classeCombustivel(p.nome)}">
            <span class="nome-combustivel">${escaparHtml(capitalizarTexto(p.nome))}</span>
            <span class="preco">${formatarPreco(p.preco)}</span>
            <span class="data-coleta">Coleta: ${escaparHtml(p.dt_coleta)}</span>
        </li>`;
    }).join('');

    return `<ul class="lista-produtos">${itens}</ul>`;
}

/* ========================================
   MARCADOR E CARD
   ======================================== */
// Produto mostrado no pin; só existe quando um único combustível está escolhido
function produtoNoMapa(posto, combustivel) {
    if (!combustivel) return null;

    const produtos = (posto.dadosPreco?.PRODUTOS ?? []).filter(function (produto) {
        return tipoCombustivel(produto.nome) === combustivel;
    });

    return produtos[0] || null;
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
        title: produto
            ? `${capitalizarTexto(produto.nome)}: ${formatarPreco(produto.preco)} — coleta: ${produto.dt_coleta}`
            : nomeDoPosto(posto)
    })
        .addTo(map)
        .bindPopup(`
            <div class="popup-posto">
                <strong>⛽ ${escaparHtml(nomeDoPosto(posto))}</strong><br>
                ${escaparHtml(enderecoDoPosto(posto))}<br><br>
                <strong>${escaparHtml(formatarDistancia(posto.distancia))}</strong>
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
    const nome = nomeDoPosto(posto);

    const card = document.createElement('div');
    card.className = 'posto';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Ver ${nome} no mapa`);

    card.addEventListener('keydown', function (evento) {
        if (evento.target !== card) return;

        if (evento.key === 'Enter' || evento.key === ' ') {
            evento.preventDefault();
            card.click();
        }
    });

    card.innerHTML = `
        <div class="posto-topo" style="background:${escaparHtml(fundoTopoDoPosto(posto))}">
            <span class="logo-marca">${logoBandeira(bandeiraDoPosto(posto))}</span>
        </div>
        <div class="posto-cabecalho">
            <h3>${escaparHtml(nome)}</h3>
            <span class="distancia">${escaparHtml(formatarDistancia(posto.distancia))}</span>
        </div>
        <p class="endereco">${escaparHtml(enderecoDoPosto(posto))}</p>
        ${htmlProdutos(posto, combustivel)}
        <a href="${escaparHtml(urlMapas)}" target="_blank" rel="noopener noreferrer">
            Ver rota no Google Maps →
        </a>
    `;

    // O link abre o Google Maps e não deve também centralizar o mapa
    card.querySelector('a').addEventListener('click', function (evento) {
        evento.stopPropagation();
    });

    card.addEventListener('click', function () {
        if (map) map.setView([posto.lat, posto.lng], 17);
    });

    $('postos').appendChild(card);
}

/* ========================================
   BOAS-VINDAS, INFORMAÇÕES E FILTROS RECOLHÍVEIS
   ======================================== */
// Copia as escolhas do diálogo inicial para os controles da página
function aplicarPreferenciasIniciais() {
    $('selRaio').value = $('welcomeRaio').value;
    atualizarBalaoRaio();

    const tipo = $('welcomeCombustivel').value;
    document.querySelectorAll('[data-fuel]').forEach(function (input) {
        input.checked = input.dataset.fuel === tipo;
    });
}

function enviarBoasVindas(evento) {
    evento.preventDefault();

    const endereco = $('welcomeEndereco').value.trim();

    if (!endereco) {
        $('welcomeError').textContent = 'Digite um endereço para buscar.';
        $('welcomeEndereco').focus();
        return;
    }

    $('welcomeError').textContent = '';
    $('endereco').value = endereco;
    aplicarPreferenciasIniciais();
    fecharDialog($('welcome'));
    buscarEndereco(endereco);
}

function usarGpsBoasVindas() {
    aplicarPreferenciasIniciais();
    fecharDialog($('welcome'));
    obterLocalizacaoGPS();
}

function abrirInfo(chave) {
    const [titulo, texto] = config.textosInfo[chave];

    $('infoTitle').textContent = titulo;
    $('infoText').textContent = texto;
    abrirDialog($('infoDialog'));
}

function alternarFiltros() {
    const botao = $('toggleFiltros');
    const recolhido = $('app').classList.toggle('collapsed');

    botao.textContent = recolhido ? '›' : '‹';
    botao.setAttribute('aria-expanded', String(!recolhido));
    botao.setAttribute('aria-label', recolhido ? 'Expandir filtros' : 'Recolher filtros');

    if (map) map.invalidateSize();
}

/* ========================================
   INICIALIZAÇÃO
   ======================================== */
function registrarEventos() {
    $('selRaio').addEventListener('input', atualizarBalaoRaio);
    $('selRaio').addEventListener('change', aplicarFiltros);

    $('btnLocalizacao').addEventListener('click', obterLocalizacaoGPS);

    $('btnEndereco').addEventListener('click', function () {
        buscarEndereco($('endereco').value.trim());
    });

    $('endereco').addEventListener('input', aoDigitar);

    $('endereco').addEventListener('keydown', function (evento) {
        if (evento.key === 'Enter') {
            evento.preventDefault();
            $('btnEndereco').click();
        }
    });

    $('selBandeira').addEventListener('change', aplicarFiltros);
    $('selOrdenacao').addEventListener('change', aplicarFiltros);
    $('chkApenasANP').addEventListener('change', aplicarFiltros);

    document.querySelectorAll('[data-fuel]').forEach(function (input) {
        input.addEventListener('change', aplicarFiltros);
    });

    $('toggleFiltros').addEventListener('click', alternarFiltros);

    document.querySelectorAll('[data-info]').forEach(function (botao) {
        botao.addEventListener('click', function () {
            abrirInfo(botao.dataset.info);
        });
    });

    $('closeInfo').addEventListener('click', function () {
        fecharDialog($('infoDialog'));
    });

    $('navPostos').addEventListener('click', function (evento) {
        evento.preventDefault();
        document.querySelector('.conteudo').scrollIntoView({ behavior: 'smooth' });
    });

    $('welcomeRaio').addEventListener('input', function () {
        $('welcomeOutput').textContent = `${$('welcomeRaio').value} km`;
    });

    $('welcomeForm').addEventListener('submit', enviarBoasVindas);
    $('welcomeGps').addEventListener('click', usarGpsBoasVindas);

    document.addEventListener('click', function (click) {
        if (!click.target.closest('.localizacao-manual')) limparSugestoes();
    });

    atualizarBalaoRaio();
}

registrarEventos();
setStatus('Escolha um endereço ou use sua localização para começar.');
prontoDados = Promise.all([carregarANP(), carregarOsm(), carregarLogos()]);
abrirDialog($('welcome'));
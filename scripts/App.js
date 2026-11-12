'use strict';

import { config, passaFiltros, ordenarPorPreco, precoDoCombustivel, capitalizarTexto } from './Regras.js';
import {
    carregarANP, carregarOsm, carregarLogos, consultarNominatim, processarElementos,
    elementosOsm, dataColetaANP, erroANP
} from './Dados.js';
import {
    $, setStatus, abrirDialog, fecharDialog, combustiveisEfetivos, combustiveisSelecionados, ehDiesel,
    criarMapa, limparResultados, mostrarMensagemLista, desenharPostos,
    atualizarBalaoRaio, atualizarBandeiras, atualizarRotuloBandeira, atualizarAvisoMapa,
    limparSugestoes, mostrarSugestoes, aplicarPreferenciasIniciais, abrirInfo, alternarFiltros
} from './Interface.js';

/* ========================================
   ESTADO DA BUSCA
   ======================================== */
let prontoDados = null;          // promessa do carregamento da ANP, do OSM e dos logos
let avisoFonte = '';             // aviso sobre a origem dos dados exibidos
let postosEncontrados = [];      // resultado da busca atual, já com distância e preço
let localUsuario = null;         // ponto de origem definido pelo usuário
let timerAutocomplete = null;

/* ========================================
   PARÂMETROS DA URL
   lat, lng (centro da busca), raio (km), comb (separado por vírgula), anp (1 ou 0)
   ======================================== */
function lerParametrosUrl() {
    const params = new URLSearchParams(window.location.search);
    const lat = parseFloat(params.get('lat'));
    const lng = parseFloat(params.get('lng'));

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const raio = Number(params.get('raio'));
    const lidos = params.get('comb') ? params.get('comb').split(',').filter(Boolean) : [];

    // Diesel e os demais combustíveis não podem vir juntos na URL
    const combustiveis = lidos.some(ehDiesel) ? lidos.filter(ehDiesel) : lidos;

    return {
        lat,
        lng,
        raio: raio >= 1 && raio <= 15 ? String(raio) : String(config.raioPadraoKm),
        combustiveis,
        apenasAnp: params.get('anp') === '1'
    };
}

// Monta a query com a busca atual. Só é usada ao sair para Sobre ou Dicas.
function montarQueryBusca() {
    if (!localUsuario) return '';

    const params = new URLSearchParams({
        lat: localUsuario.lat.toFixed(5),
        lng: localUsuario.lng.toFixed(5),
        raio: $('selRaio').value,
        comb: combustiveisSelecionados().join(','),
        anp: $('chkApenasANP').checked ? '1' : '0'
    });

    return `?${params}`;
}

// Atualiza os links de Sobre e Dicas com a busca atual, sem alterar a URL do mapa
function atualizarLinksNavegacao() {
    const query = montarQueryBusca();

    $('navSobre').href = `./pages/sobre.html${query}`;
    $('navDicas').href = `./pages/dicas.html${query}`;
}

/* ========================================
   LEITURA DOS FILTROS
   ======================================== */
function lerFiltros() {
    return {
        raioKm: Number($('selRaio').value),
        bandeira: $('selBandeira').value,
        combustiveis: combustiveisEfetivos(),
        apenasAnp: $('chkApenasANP').checked
    };
}

function postosParaBandeiras() {
    const raioKm = Number($('selRaio').value);
    const apenasAnp = $('chkApenasANP').checked;

    return postosEncontrados.filter(p => p.distancia <= raioKm && (!apenasAnp || p.dadosPreco));
}

/* ========================================
   APLICAR FILTROS
   ======================================== */
function aplicarFiltros() {
    if (!localUsuario) return;

    atualizarLinksNavegacao();

    const filtros = lerFiltros();
    const combustivel = filtros.combustiveis.length === 1 ? filtros.combustiveis[0] : '';
    const ordenacao = $('selOrdenacao').value;

    atualizarAvisoMapa(combustiveisSelecionados());
    atualizarRotuloBandeira();
    limparResultados();

    let lista = postosEncontrados.filter(posto => passaFiltros(posto, filtros));

    if (ordenacao === 'preco' && combustivel) {
        lista = ordenarPorPreco(lista, combustivel);
    }

    if (lista.length === 0) {
        const mensagem = combustiveisSelecionados().length === 0
            ? 'Selecione um combustível para ver os postos e preços.'
            : 'Nenhum posto encontrado com esses filtros.';

        mostrarMensagemLista(mensagem);
        setStatus(mensagem + avisoFonte);
        return;
    }

    desenharPostos(lista, combustivel);

    const comPreco = lista.filter(posto => posto.dadosPreco).length;
    let mensagem = `${lista.length} postos encontrados em até ${filtros.raioKm} km. ${comPreco} com preços da ANP.`;

    if (combustivel) {
        const semPreco = lista.filter(p => precoDoCombustivel(p, combustivel) === null).length;

        if (semPreco > 0) {
            mensagem += ` ${semPreco} sem preço informado para ${capitalizarTexto(combustivel.replace(/-/g, ' '))}.`;
        }
    }

    if (ordenacao === 'preco' && !combustivel) {
        mensagem += ' Escolha um combustível para ordenar por preço.';
    }

    setStatus(mensagem + avisoFonte);
}

/* ========================================
   REGRA: DIESEL × GASOLINA/ETANOL
   ======================================== */
// Marcar diesel desmarca gasolina, aditivada e etanol; marcar esses desmarca os diesels
function aoMarcarCombustivel(evento) {
    const alterado = evento.target;

    if (alterado.checked) {
        const marcadoEhDiesel = ehDiesel(alterado.dataset.fuel);

        for (const input of document.querySelectorAll('[data-fuel]')) {
            if (input === alterado || !input.checked) continue;

            if (ehDiesel(input.dataset.fuel) !== marcadoEhDiesel) {
                input.checked = false;
            }
        }
    }

    aplicarFiltros();
}

/* ========================================
   BUSCA DE POSTOS (ARQUIVO SALVO)
   ======================================== */
function montarAviso() {
    let aviso = ' Localização: postos do OpenStreetMap. Preços: ANP';

    if (dataColetaANP) aviso += `, coletados em ${dataColetaANP}`;
    aviso += '.';

    if (erroANP) aviso += ' Não foi possível carregar a base de preços da ANP.';

    return aviso;
}

async function buscarPostos() {
    setStatus('Carregando os preços da ANP...');
    await prontoDados;

    if (!elementosOsm) {
        postosEncontrados = [];
        avisoFonte = ' OSM indisponível: não foi possível confirmar a localização dos postos. Recarregue a página.';
        atualizarBandeiras(postosParaBandeiras(), aplicarFiltros);
        aplicarFiltros();
        return;
    }

    postosEncontrados = processarElementos(elementosOsm, localUsuario);
    avisoFonte = montarAviso();
    atualizarBandeiras(postosParaBandeiras(), aplicarFiltros);
    aplicarFiltros();
}

async function usarLocalizacao(lat, lng, mensagem) {
    localUsuario = { lat, lng };
    setStatus(mensagem);

    // O mapa só é criado quando o usuário define o local
    if (!criarMapa(localUsuario)) return;

    postosEncontrados = [];
    await buscarPostos();
}

/* ========================================
   ORIGEM: ENDEREÇO OU GPS
   ======================================== */
function obterLocalizacaoGPS() {
    const botao = $('btnLocalizacao');

    if (!navigator.geolocation) {
        setStatus('Seu navegador não suporta geolocalização.');
        return;
    }

    if (!window.isSecureContext) {
        setStatus('A localização só funciona em site HTTPS ou localhost.');
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
            console.error('Geolocalização:', erro.code, erro.message);
            botao.disabled = false;

            const mensagens = {
                1: 'Permissão de localização negada. Libere o acesso no cadeado do navegador e tente de novo.',
                2: 'Não foi possível determinar sua posição. Tente novamente.',
                3: 'Tempo esgotado para obter sua localização. Tente novamente.'
            };

            setStatus(mensagens[erro.code] || 'Erro ao obter localização.');
        },
        { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 }
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
   AUTOCOMPLETE
   ======================================== */
function escolherLocal(local, campo) {
    campo.value = local.display_name;
    limparSugestoes();
    usarLocalizacao(parseFloat(local.lat), parseFloat(local.lon), 'Endereço selecionado!');
}

async function buscarSugestoes(termo, campo) {
    try {
    const resultados = await consultarNominatim(termo, 3);
        
    const unicos = resultados.filter((local, index, self) => 
        index === self.findIndex(l => l.display_name === local.display_name)
    );
    mostrarSugestoes(unicos, escolherLocal, campo);
    } catch (erro) {
        console.error('Erro no autocomplete:', erro);
    }
}

function aoDigitar(evento) {
    const campo = evento.target;
    const texto = evento.target.value.trim();
    clearTimeout(timerAutocomplete);

    if (texto.length < config.minCaracteresBusca) {
        limparSugestoes();
        return;
    }

    timerAutocomplete = setTimeout(function () {
        campo.setAttribute('autocomplete', texto ? 'off' : 'on');
        buscarSugestoes(texto, campo);
    }, config.atrasoAutocompleteMs);
}

/* ========================================
   BOAS-VINDAS
   ======================================== */
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
    $('welcomeEndereco').addEventListener('input', aoDigitar);

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
        input.addEventListener('change', aoMarcarCombustivel);
    });

    // A query da busca é montada no momento em que o usuário vai para Sobre ou Dicas
    $('navSobre').addEventListener('mouseenter', atualizarLinksNavegacao);
    $('navDicas').addEventListener('mouseenter', atualizarLinksNavegacao);
    $('navSobre').addEventListener('focus', atualizarLinksNavegacao);
    $('navDicas').addEventListener('focus', atualizarLinksNavegacao);

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

    function atualizarRaioBoasVindas() {
        const slider = $('welcomeRaio');
        const min = Number(slider.min);
        const max = Number(slider.max);
        const valor = Number(slider.value);
        const percentual = (valor - min) / (max - min) * 100;

    $('welcomeOutput').textContent = `${valor} km`;
    slider.style.setProperty('--progress', `${percentual}%`);
}

    $('welcomeRaio').addEventListener('input', atualizarRaioBoasVindas);
    atualizarRaioBoasVindas();

    $('welcomeForm').addEventListener('submit', enviarBoasVindas);
    $('welcomeGps').addEventListener('click', usarGpsBoasVindas);

    atualizarBalaoRaio();
}

registrarEventos();
setStatus('Escolha um endereço ou use sua localização para começar.');
prontoDados = Promise.all([carregarANP(), carregarOsm(), carregarLogos()]);

const preferenciasUrl = lerParametrosUrl();

if (preferenciasUrl) {
    // Restaura a busca vinda da URL, sem abrir o diálogo de boas-vindas
    aplicarPreferenciasIniciais({
        raio: preferenciasUrl.raio,
        combustiveis: preferenciasUrl.combustiveis,
        apenasAnp: preferenciasUrl.apenasAnp
    });
    usarLocalizacao(preferenciasUrl.lat, preferenciasUrl.lng, 'Restaurando sua busca...');
} else {
    abrirDialog($('welcome'));
}
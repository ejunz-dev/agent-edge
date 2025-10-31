import './style.css';

import {
    create, NButton, NCard, NConfigProvider, NGi, NGrid,
    NNotificationProvider, NScrollbar, NSpace, NStatistic, NTabs, NTabPane, NTag, darkTheme, useOsTheme,
} from 'naive-ui';
import { createApp } from 'vue';
import App from './App.vue';

const naive = create({
    components: [NButton, NGrid, NGi, NCard, NStatistic, NSpace, NConfigProvider, NTabs, NTabPane, NTag, NNotificationProvider, NScrollbar, darkTheme, useOsTheme],
});

createApp(App).use(naive).mount('#app');

